import {
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { clamp } from "@/lib/core/math";

export type FloatingCardFrame = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export function clampFloatingCard(
	frame: FloatingCardFrame,
	viewport: { width: number; height: number },
): FloatingCardFrame {
	const edge = 12;
	const width = clamp(
		frame.width,
		Math.max(0, Math.min(220, viewport.width - edge * 2)),
		Math.max(0, viewport.width - edge * 2),
	);
	const height = clamp(
		frame.height,
		Math.max(0, Math.min(120, viewport.height - edge * 2)),
		Math.max(0, viewport.height - edge * 2),
	);
	return {
		width,
		height,
		left: clamp(
			frame.left,
			edge,
			Math.max(edge, viewport.width - width - edge),
		),
		top: clamp(
			frame.top,
			edge,
			Math.max(edge, viewport.height - height - edge),
		),
	};
}

export type FloatingCardOptions = {
	pinned: boolean;
	onPinnedChange: (pinned: boolean) => void;
	/**
	 * Controlled frame: the owner keeps the pinned position (e.g. relative to
	 * the content it annotates) and receives every move / resize. Uncontrolled
	 * cards keep a viewport frame of their own and stay clamped to the window.
	 */
	frame?: FloatingCardFrame | null;
	onFrameChange?: (frame: FloatingCardFrame) => void;
};

export function useFloatingCard(
	rootRef: RefObject<HTMLDivElement | null>,
	floating?: FloatingCardOptions,
) {
	const [ownFrame, setOwnFrame] = useState<FloatingCardFrame | null>(null);
	const controlled = floating?.onFrameChange !== undefined;
	const frame = controlled ? (floating?.frame ?? null) : ownFrame;
	const frameRef = useRef(frame);
	frameRef.current = frame;
	const onFrameChangeRef = useRef(floating?.onFrameChange);
	onFrameChangeRef.current = floating?.onFrameChange;
	const setFrame = (next: FloatingCardFrame) => {
		if (controlled) onFrameChangeRef.current?.(next);
		else setOwnFrame(next);
	};
	const gesture = useRef<{
		pointerId: number;
		x: number;
		y: number;
		frame: FloatingCardFrame;
		resize: boolean;
	} | null>(null);
	const readFrame = () => {
		const rect = rootRef.current?.getBoundingClientRect();
		return rect
			? {
					left: rect.left,
					top: rect.top,
					width: rect.width,
					height: rect.height,
				}
			: null;
	};
	const bound = (next: FloatingCardFrame) =>
		clampFloatingCard(next, {
			width: window.innerWidth,
			height: window.innerHeight,
		});
	useEffect(() => {
		if (!floating?.pinned) {
			if (!controlled) setOwnFrame(null);
			return;
		}
		const rect = rootRef.current?.getBoundingClientRect();
		if (rect && !frameRef.current) {
			const initial = {
				left: rect.left,
				top: rect.top,
				width: rect.width,
				height: rect.height,
			};
			if (controlled) onFrameChangeRef.current?.(initial);
			else setOwnFrame(initial);
		}
		// Controlled frames follow their content, not the window.
		if (controlled) return;
		const onResize = () =>
			setOwnFrame((prev) =>
				prev
					? clampFloatingCard(prev, {
							width: window.innerWidth,
							height: window.innerHeight,
						})
					: prev,
			);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [floating?.pinned, controlled, rootRef]);
	const onPointerDown = (
		event: PointerEvent<HTMLButtonElement>,
		resize: boolean,
	) => {
		if (event.button !== 0 || !floating) return;
		const initial = readFrame();
		if (!initial) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		gesture.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			frame: initial,
			resize,
		};
		setFrame(bound(initial));
		floating.onPinnedChange(true);
	};
	const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		const start = gesture.current;
		if (!start || start.pointerId !== event.pointerId) return;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		const next = start.resize
			? {
					...start.frame,
					width: start.frame.width + dx,
					height: start.frame.height + dy,
				}
			: {
					...start.frame,
					left: start.frame.left + dx,
					top: start.frame.top + dy,
				};
		// Resize keeps its top-left corner fixed even when reaching an edge.
		if (start.resize) {
			next.width = Math.min(next.width, window.innerWidth - next.left - 12);
			next.height = Math.min(next.height, window.innerHeight - next.top - 12);
		}
		setFrame(bound(next));
	};
	const onPointerEnd = () => {
		gesture.current = null;
	};
	const onKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		resize: boolean,
	) => {
		if (
			!floating ||
			!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
		)
			return;
		const initial = readFrame();
		if (!initial) return;
		event.preventDefault();
		event.stopPropagation();
		const step = event.shiftKey ? 4 : 16;
		const dx =
			event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
		const dy =
			event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
		const next = resize
			? {
					...initial,
					width: Math.min(
						initial.width + dx,
						window.innerWidth - initial.left - 12,
					),
					height: Math.min(
						initial.height + dy,
						window.innerHeight - initial.top - 12,
					),
				}
			: { ...initial, left: initial.left + dx, top: initial.top + dy };
		setFrame(bound(next));
		floating.onPinnedChange(true);
	};
	const handleProps = (resize: boolean) => ({
		onPointerDown: (event: PointerEvent<HTMLButtonElement>) =>
			onPointerDown(event, resize),
		onPointerMove,
		onPointerUp: onPointerEnd,
		onPointerCancel: onPointerEnd,
		onLostPointerCapture: onPointerEnd,
		onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
			onKeyDown(event, resize),
	});
	return {
		frame,
		moveProps: handleProps(false),
		resizeProps: handleProps(true),
	};
}
