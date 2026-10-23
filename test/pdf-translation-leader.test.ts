import { describe, expect, it } from "vitest";
import { sourceLeader } from "@/components/viewer/pdf/chrome/pdf-card-stack";
import { translationCardFrame } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";

describe("translation card source link", () => {
	const source = [
		{ left: 100, top: 100, width: 200, height: 12 },
		{ left: 100, top: 114, width: 120, height: 12 },
	];

	it("joins the nearest points of the source text and the card", () => {
		const leader = sourceLeader(source, {
			left: 400,
			top: 90,
			width: 200,
			height: 80,
		});
		expect(leader).toEqual({ x1: 300, y1: 126, x2: 400, y2: 126 });
	});

	it("draws nothing when the card covers its source", () => {
		expect(
			sourceLeader(source, { left: 50, top: 50, width: 400, height: 200 }),
		).toBeNull();
	});

	it("keeps a pinned card at its offset from the moving source", () => {
		const card = {
			screen: { x: 80, y: 300 },
			offset: { dx: -240, dy: 20, width: 260, height: 180 },
		};
		expect(translationCardFrame(card)).toEqual({
			left: -160,
			top: 320,
			width: 260,
			height: 180,
		});
		expect(translationCardFrame({ ...card, offset: null })).toBeNull();
	});
});
