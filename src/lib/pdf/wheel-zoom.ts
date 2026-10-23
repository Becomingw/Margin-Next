/**
 * Wheel-zoom coalescing for the PDF viewer.
 *
 * Trackpad pinch / Ctrl+wheel delivers many small wheel events per second.
 * Applying a zoom step per event re-rasterizes every visible page (main-thread
 * PDFium) once per event. This coalescer accumulates deltas and applies all
 * resulting steps in one synchronous batch per animation frame, so React and
 * EmbedPDF only re-render once per frame regardless of event rate.
 */

/** One discrete zoom step per this much accumulated wheel deltaY. */
const WHEEL_ZOOM_STEP_DELTA = 100;

/** Normalize mouse line/page units into the pixel stream used by trackpads. */
export function pdfWheelDeltaPixels(
	event: Pick<WheelEvent, "deltaY" | "deltaMode">,
	pageHeight: number,
): number {
	if (!Number.isFinite(event.deltaY)) return 0;
	const unit =
		event.deltaMode === 1
			? 40
			: event.deltaMode === 2
				? Math.max(100, pageHeight)
				: 1;
	return Math.max(-300, Math.min(300, event.deltaY * unit));
}

type WheelZoomCoalescerOptions = {
	/** Wheel delta that produces one zoom step. */
	threshold?: number;
	onZoomIn: () => void;
	onZoomOut: () => void;
	requestFrame?: (callback: FrameRequestCallback) => number;
	cancelFrame?: (handle: number) => void;
};

type WheelZoomCoalescer = {
	/** Accumulate one wheel `deltaY`; steps flush at most once per frame. */
	addDelta(delta: number): void;
	/** Drop pending accumulation (a new gesture starts). */
	reset(): void;
	dispose(): void;
};

export function createWheelZoomCoalescer({
	threshold = WHEEL_ZOOM_STEP_DELTA,
	onZoomIn,
	onZoomOut,
	requestFrame = (callback) => requestAnimationFrame(callback),
	cancelFrame = (handle) => cancelAnimationFrame(handle),
}: WheelZoomCoalescerOptions): WheelZoomCoalescer {
	let accumulated = 0;
	let pendingFrame: number | null = null;
	let disposed = false;

	const flush = () => {
		pendingFrame = null;
		if (disposed) return;
		while (Math.abs(accumulated) >= threshold) {
			if (accumulated > 0) {
				onZoomOut();
				accumulated -= threshold;
			} else {
				onZoomIn();
				accumulated += threshold;
			}
		}
	};

	return {
		addDelta(delta: number) {
			if (disposed) return;
			accumulated += delta;
			if (pendingFrame === null) {
				pendingFrame = requestFrame(flush);
			}
		},
		reset() {
			accumulated = 0;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			accumulated = 0;
			if (pendingFrame !== null) {
				cancelFrame(pendingFrame);
				pendingFrame = null;
			}
		},
	};
}

/** Wheel stream must be silent this long before a scroll gesture is over. */
const WHEEL_SCROLL_IDLE_MS = 200;

/**
 * Wheel deltaY units per unit of natural log magnification. A full 2× pinch
 * (ln 2 ≈ 0.69) yields ~690 delta ≈ 7 toolbar-sized zoom steps.
 */
const GESTURE_SCALE_DELTA_GAIN = 1000;

/** Minimal shape of WebKit's non-standard GestureEvent. */
type WebKitGestureEvent = { scale: number; preventDefault(): void };

type WheelZoomGestureOptions = {
	target: Pick<HTMLElement, "addEventListener" | "removeEventListener"> &
		Partial<Pick<HTMLElement, "ownerDocument">>;
	/** Ctrl/Cmd+wheel or trackpad pinch tick, already default-prevented when possible. */
	onZoomWheel: (event: WheelEvent) => void;
	/** Wheel-idle delay before plain scrolling is assumed finished. */
	scrollIdleMs?: number;
};

/**
 * Bind wheel-zoom without keeping the container permanently non-passive.
 *
 * A non-passive wheel listener forces every tick through the main thread before
 * the container may scroll, which shows up as scroll jank whenever the viewer is
 * busy. Zoom still needs `preventDefault` (platform pinch zoom would otherwise
 * scale the whole app), so the non-passive listener stays attached until a plain
 * scroll gesture starts and comes back once the wheel stream goes idle. A pinch
 * that begins mid-scroll still zooms; only that first tick keeps its default.
 *
 * On WebKit (Safari / macOS WKWebView) trackpad pinch never arrives as
 * ctrl+wheel; it is delivered as gesturestart/gesturechange/gestureend
 * instead. Those are translated into wheel-equivalent deltas for the same
 * `onZoomWheel` path and default-prevented so the platform magnify is
 * suppressed.
 */
export function bindWheelZoomGesture({
	target,
	onZoomWheel,
	scrollIdleMs = WHEEL_SCROLL_IDLE_MS,
}: WheelZoomGestureOptions): { dispose(): void } {
	let passive = false;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const clearIdleTimer = () => {
		if (idleTimer === null) return;
		clearTimeout(idleTimer);
		idleTimer = null;
	};

	const setPassive = (next: boolean) => {
		if (passive === next) return;
		target.removeEventListener(
			"wheel",
			passive ? passiveListener : activeListener,
		);
		passive = next;
		target.addEventListener("wheel", next ? passiveListener : activeListener, {
			passive: next,
		});
	};

	const handleWheel = (event: WheelEvent, canPreventDefault: boolean) => {
		if (disposed) return;
		if (event.ctrlKey || event.metaKey) {
			if (canPreventDefault && event.cancelable) event.preventDefault();
			clearIdleTimer();
			setPassive(false);
			onZoomWheel(event);
			return;
		}
		setPassive(true);
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			setPassive(false);
		}, scrollIdleMs);
	};

	function activeListener(event: WheelEvent) {
		handleWheel(event, true);
	}
	function passiveListener(event: WheelEvent) {
		handleWheel(event, false);
	}
	// Ctrl is pressed before its first wheel tick. Re-arm here so switching
	// from scrolling to Ctrl+wheel cannot zoom the app or scroll the PDF once.
	const onModifierKey = (event: KeyboardEvent) => {
		if (!event.ctrlKey && !event.metaKey) return;
		clearIdleTimer();
		setPassive(false);
	};
	target.ownerDocument?.addEventListener("keydown", onModifierKey, true);

	// WebKit (Safari / macOS WKWebView) delivers trackpad pinch as
	// GestureEvents instead of ctrl+wheel ticks; feed the same coalescer with a
	// wheel-equivalent delta derived from the magnification ratio.
	let gestureScale = 1;
	const handleGestureStart = (raw: Event) => {
		if (disposed) return;
		const event = raw as unknown as WebKitGestureEvent;
		event.preventDefault();
		gestureScale = event.scale || 1;
	};
	const handleGestureChange = (raw: Event) => {
		if (disposed) return;
		const event = raw as unknown as WebKitGestureEvent;
		event.preventDefault();
		const scale = event.scale || 1;
		const ratio = scale / gestureScale;
		gestureScale = scale;
		if (!(ratio > 0) || ratio === 1) return;
		onZoomWheel({
			deltaY: -GESTURE_SCALE_DELTA_GAIN * Math.log(ratio),
		} as unknown as WheelEvent);
	};
	const handleGestureEnd = (raw: Event) => {
		if (disposed) return;
		(raw as unknown as WebKitGestureEvent).preventDefault();
		gestureScale = 1;
	};

	target.addEventListener("wheel", activeListener, { passive: false });
	target.addEventListener("gesturestart", handleGestureStart);
	target.addEventListener("gesturechange", handleGestureChange);
	target.addEventListener("gestureend", handleGestureEnd);

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			clearIdleTimer();
			target.ownerDocument?.removeEventListener("keydown", onModifierKey, true);
			target.removeEventListener(
				"wheel",
				passive ? passiveListener : activeListener,
			);
			target.removeEventListener("gesturestart", handleGestureStart);
			target.removeEventListener("gesturechange", handleGestureChange);
			target.removeEventListener("gestureend", handleGestureEnd);
		},
	};
}

/** Wheel-equivalent delta per pixel of right-drag travel: ~20px per 10% step. */
const RIGHT_DRAG_DELTA_GAIN = 5;
/** Travel before a right press counts as a zoom drag rather than a click. */
const RIGHT_DRAG_SLOP_PX = 3;

/** Text fields and floating chrome keep their own right-click behavior. */
function isRightDragExempt(target: EventTarget | null): boolean {
	const element = target as Element | null;
	return Boolean(
		element?.closest?.(
			'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-pdf-chrome]',
		),
	);
}

type RightDragZoomOptions = {
	target: Pick<HTMLElement, "addEventListener" | "removeEventListener"> &
		Partial<Pick<HTMLElement, "ownerDocument">>;
	/**
	 * Wheel-equivalent delta (negative = zoom in) and the viewport point the
	 * drag started from, which zoom should stay anchored to.
	 */
	onZoomDrag: (
		delta: number,
		anchor: { clientX: number; clientY: number },
	) => void;
};

/**
 * Hold the right mouse button and move up to zoom in, down to zoom out.
 *
 * The page area has no context menu of its own, so the native WebView menu is
 * suppressed there — on macOS it would open on press and swallow the drag.
 * Text fields and chrome keep theirs.
 */
export function bindRightDragZoom({
	target,
	onZoomDrag,
}: RightDragZoomOptions): { dispose(): void } {
	const doc = target.ownerDocument;
	let drag: {
		pointerId: number;
		lastY: number;
		travel: number;
		anchor: { clientX: number; clientY: number };
	} | null = null;

	const onPointerDown = (event: PointerEvent) => {
		if (event.button !== 2 || isRightDragExempt(event.target)) return;
		drag = {
			pointerId: event.pointerId,
			lastY: event.clientY,
			travel: 0,
			anchor: { clientX: event.clientX, clientY: event.clientY },
		};
	};
	const onPointerMove = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.pointerId) return;
		if (!(event.buttons & 2)) {
			drag = null;
			return;
		}
		const dy = event.clientY - drag.lastY;
		drag.lastY = event.clientY;
		drag.travel += Math.abs(dy);
		if (drag.travel < RIGHT_DRAG_SLOP_PX || dy === 0) return;
		if (event.cancelable) event.preventDefault();
		onZoomDrag(dy * RIGHT_DRAG_DELTA_GAIN, drag.anchor);
	};
	const onPointerEnd = (event: PointerEvent) => {
		if (drag && event.pointerId === drag.pointerId) drag = null;
	};
	const onContextMenu = (event: Event) => {
		if (!isRightDragExempt(event.target)) event.preventDefault();
	};

	target.addEventListener("pointerdown", onPointerDown as EventListener);
	target.addEventListener("contextmenu", onContextMenu);
	doc?.addEventListener("pointermove", onPointerMove);
	doc?.addEventListener("pointerup", onPointerEnd);
	doc?.addEventListener("pointercancel", onPointerEnd);

	return {
		dispose() {
			target.removeEventListener("pointerdown", onPointerDown as EventListener);
			target.removeEventListener("contextmenu", onContextMenu);
			doc?.removeEventListener("pointermove", onPointerMove);
			doc?.removeEventListener("pointerup", onPointerEnd);
			doc?.removeEventListener("pointercancel", onPointerEnd);
		},
	};
}
