import type { KeyboardEvent, PointerEvent } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	clampFloatingCard,
	type FloatingCardFrame,
	useFloatingCard,
} from "@/components/viewer/pdf/cards/use-floating-card";

const { state } = vi.hoisted(() => ({
	state: { frame: null as FloatingCardFrame | null },
}));
vi.mock("react", () => ({
	useState: () => [
		null,
		(
			next:
				| FloatingCardFrame
				| null
				| ((prev: FloatingCardFrame | null) => FloatingCardFrame | null),
		) => {
			state.frame = typeof next === "function" ? next(state.frame) : next;
		},
	],
	useRef: (current: unknown) => ({ current }),
	useEffect: () => {},
}));
beforeEach(() => {
	state.frame = null;
	vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600 });
});
afterEach(() => vi.unstubAllGlobals());

function harness() {
	const initial = { left: 100, top: 100, width: 260, height: 200 };
	const root = {
		current: {
			getBoundingClientRect: () => state.frame ?? initial,
		} as HTMLDivElement,
	};
	const pin = vi.fn();
	// biome-ignore lint/correctness/useHookAtTopLevel: Gesture callbacks run with deterministic hook stand-ins.
	const card = useFloatingCard(root, { pinned: false, onPinnedChange: pin });
	return { ...card, pin };
}
function pointer(x: number, y: number) {
	return {
		pointerId: 1,
		button: 0,
		clientX: x,
		clientY: y,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		currentTarget: { setPointerCapture: vi.fn() },
	} as unknown as PointerEvent<HTMLButtonElement>;
}
it("tracks dragging 1:1 from the grab offset, pins, and stops after cancellation", () => {
	const h = harness();
	const start = pointer(120, 110);
	h.moveProps.onPointerDown(start);
	expect(start.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
	h.moveProps.onPointerMove(pointer(170, 150));
	expect(state.frame).toEqual({ left: 150, top: 140, width: 260, height: 200 });
	expect(h.pin).toHaveBeenCalledWith(true);
	h.moveProps.onPointerCancel();
	h.moveProps.onPointerMove(pointer(300, 300));
	expect(state.frame?.left).toBe(150);
});
it("resizes from the bottom-right while keeping the top-left fixed and fitting the viewport", () => {
	const h = harness();
	h.resizeProps.onPointerDown(pointer(360, 300));
	h.resizeProps.onPointerMove(pointer(500, 400));
	expect(state.frame).toEqual({ left: 100, top: 100, width: 400, height: 300 });
	h.resizeProps.onPointerMove(pointer(1500, 1500));
	expect(state.frame).toEqual({ left: 100, top: 100, width: 688, height: 488 });
});
it("supports arrow-key movement and fine keyboard resizing", () => {
	const h = harness();
	const key = (key: string, shiftKey = false) =>
		({
			key,
			shiftKey,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		}) as unknown as KeyboardEvent<HTMLButtonElement>;
	h.moveProps.onKeyDown(key("ArrowRight"));
	expect(state.frame?.left).toBe(116);
	h.resizeProps.onKeyDown(key("ArrowDown", true));
	expect(state.frame?.height).toBe(204);
	expect(h.pin).toHaveBeenCalledWith(true);
});
it("brings a moved/resized card back inside a smaller viewport", () => {
	const frame = clampFloatingCard(
		{ left: 900, top: 600, width: 600, height: 500 },
		{ width: 390, height: 300 },
	);
	expect(frame).toEqual({ left: 12, top: 12, width: 366, height: 276 });
});
