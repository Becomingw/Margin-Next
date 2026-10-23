import { describe, expect, it } from "vitest";
import { isPdfCitationFragment } from "@/lib/agent/citation-href";
import {
	hasWikilinkChange,
	selectedWikilinkChanges,
	toggleWikilinkChanges,
	type WikilinkDraft,
} from "@/lib/doctor/wikilink-review";

function draft(
	id: string,
	replacement: string,
	selected = false,
): WikilinkDraft {
	return {
		id,
		source: "notes/Source.md",
		line: 1,
		status: "missing",
		syntax: "wikilink",
		embed: false,
		targetRaw: "old",
		expected: "old",
		suggestedReplacement: replacement,
		editKind: "target",
		rangeStart: 2,
		rangeEnd: 5,
		expectedHash: "hash",
		linePrefix: "[[",
		lineSuffix: "]]",
		layer: "manual",
		reason: "manual edit required",
		selectedByDefault: false,
		candidates: [],
		selected,
	};
}

describe("Doctor effective repair selection", () => {
	it("select all includes changed targets, but never untouched manual placeholders or blanks", () => {
		const rows = [
			draft("automatic", "Target", true),
			draft("manual", "old"),
			draft("edited", "Other"),
			draft("blank", "   "),
		];
		const selected = toggleWikilinkChanges(rows);
		expect(selectedWikilinkChanges(selected).map((row) => row.id)).toEqual([
			"automatic",
			"edited",
		]);
		expect(selectedWikilinkChanges(toggleWikilinkChanges(selected))).toEqual(
			[],
		);
		expect(toggleWikilinkChanges([draft("manual", "old")])[0].selected).toBe(
			false,
		);
	});
	it("filters stale selected placeholders at submission and allows a real manual correction", () => {
		const untouched = draft("manual", "old", true);
		expect(selectedWikilinkChanges([untouched])).toEqual([]);
		expect(
			hasWikilinkChange({ ...untouched, suggestedReplacement: "Target" }),
		).toBe(true);
		expect(
			selectedWikilinkChanges([
				{ ...untouched, suggestedReplacement: "Target" },
			]),
		).toHaveLength(1);
	});
});

describe("PDF citation fragment syntax", () => {
	const fragment = (value: string) => ({ kind: "heading", path: [value] });
	it("recognizes reader routes without pretending they are Markdown headings", () => {
		for (const value of [
			"page=1",
			"section=2.2",
			"section=III",
			"figure=2",
			"table=1",
			"algorithm=1",
			"formula=3",
			"region=figure-1",
		])
			expect(
				isPdfCitationFragment("papers/demo/demo.PDF", fragment(value)),
			).toBe(true);
		expect(isPdfCitationFragment("notes/Source.md", fragment("page=1"))).toBe(
			false,
		);
		for (const value of [
			"page=0",
			"page=-1",
			"page=4294967296",
			"figure=banana",
			"section=",
			"region=%20",
			"section=%00",
			"unknown=1",
			"Introduction",
		])
			expect(isPdfCitationFragment("paper.pdf", fragment(value))).toBe(false);
	});
});
