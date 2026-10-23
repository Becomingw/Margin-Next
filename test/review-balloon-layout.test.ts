import { describe, expect, it } from "vitest";
import { layoutBalloons } from "@/lib/review/balloon-layout";

const items = [
	{ id: "a", anchorY: 300 },
	{ id: "b", anchorY: 310 },
	{ id: "c", anchorY: 320 },
	{ id: "d", anchorY: 500 },
];
const heights = { a: 60, b: 60, c: 200, d: 60 };

describe("comment column layout", () => {
	it("stacks crowded cards downward without a focus", () => {
		expect(layoutBalloons(items, heights, null)).toEqual([300, 370, 440, 650]);
	});

	it("keeps the focused card level with its text, moving earlier cards up", () => {
		expect(layoutBalloons(items, heights, "c")).toEqual([180, 250, 320, 530]);
	});

	it("never rises above the column or overlaps near its top", () => {
		const near = items.map((item) => ({
			...item,
			anchorY: item.anchorY - 250,
		}));
		expect(layoutBalloons(near, heights, "c")).toEqual([8, 78, 148, 358]);
	});
});
