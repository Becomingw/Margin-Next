import { useViewportElement } from "@embedpdf/plugin-viewport/react";
import { useZoom } from "@embedpdf/plugin-zoom/react";
import { useEffect, useRef } from "react";
import {
	bindRightDragZoom,
	bindWheelZoomGesture,
	createWheelZoomCoalescer,
	pdfWheelDeltaPixels,
} from "@/lib/pdf/wheel-zoom";

/** Wheel gesture idle window before pending zoom deltas are dropped. */
const WHEEL_ZOOM_RESET_MS = 150;

/**
 * Custom Ctrl/Cmd+wheel, pinch and right-drag zoom handler.
 *
 * EmbedPDF's ZoomGestureWrapper multiplies the current scale by a factor
 * derived from `deltaY`, which makes a single mouse-wheel tick double or
 * halve the zoom. We disable that built-in behavior and instead step the zoom
 * in fixed 10-percentage-point increments around the pointer.
 *
 * Steps are coalesced per animation frame (createWheelZoomCoalescer): a
 * trackpad pinch fires many wheel events per second, and each applied step
 * re-rasterizes all visible pages on the main thread — batching keeps that to
 * once per frame. bindWheelZoomGesture keeps the listener passive while the user
 * is merely scrolling, so plain scrolls stay off the main thread.
 */
export function WheelZoomHandler({ docId }: { docId: string }) {
	const viewportRef = useViewportElement();
	const { provides: zoom } = useZoom(docId);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;

	useEffect(() => {
		const container = viewportRef?.current;
		if (!container) return;

		let center: { vx: number; vy: number } | undefined;
		const coalescer = createWheelZoomCoalescer({
			onZoomIn: () => zoomRef.current?.requestZoomBy(0.1, center),
			onZoomOut: () => zoomRef.current?.requestZoomBy(-0.1, center),
		});

		let resetTimeout: ReturnType<typeof setTimeout> | null = null;
		const scheduleReset = () => {
			if (resetTimeout) clearTimeout(resetTimeout);
			resetTimeout = setTimeout(() => {
				resetTimeout = null;
				coalescer.reset();
			}, WHEEL_ZOOM_RESET_MS);
		};

		const binding = bindWheelZoomGesture({
			target: container,
			onZoomWheel: (e) => {
				if (!zoomRef.current) return;
				const bounds = container.getBoundingClientRect();
				center =
					Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
						? { vx: e.clientX - bounds.left, vy: e.clientY - bounds.top }
						: undefined;
				coalescer.addDelta(pdfWheelDeltaPixels(e, container.clientHeight));
				scheduleReset();
			},
		});

		// Right-drag feeds the same coalescer, anchored where the drag began.
		const rightDrag = bindRightDragZoom({
			target: container,
			onZoomDrag: (delta, anchor) => {
				if (!zoomRef.current) return;
				const bounds = container.getBoundingClientRect();
				center = {
					vx: anchor.clientX - bounds.left,
					vy: anchor.clientY - bounds.top,
				};
				coalescer.addDelta(delta);
				scheduleReset();
			},
		});

		return () => {
			binding.dispose();
			rightDrag.dispose();
			if (resetTimeout) clearTimeout(resetTimeout);
			coalescer.dispose();
		};
	}, [viewportRef]);

	return null;
}
