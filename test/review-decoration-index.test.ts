import { createSlateEditor, NodeApi, RangeApi, type TRange } from "platejs";
import { createPlateEditor, Plate, PlateContent } from "platejs/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewAnchorPlugin } from "@/components/review/review-anchor-plugin";
import type { ReviewAnchorRange } from "@/lib/review/anchor";
import {
	buildReviewSnapshot,
	indexReviewDecorations,
	presentRanges,
} from "@/lib/review/decoration-index";

describe("review decoration propagation", () => {
	it.each([
		undefined,
		"agent",
	] as const)("keeps insertion and deletion semantics distinct for %s revisions", (actor) => {
		const editor = createPlateEditor({
			plugins: [ReviewAnchorPlugin],
			value: [{ type: "p", children: [{ text: "new text" }] }],
		});
		const ranges: ReviewAnchorRange[] = [
			{
				anchorId: "chg-replace",
				reviewAnchor: true,
				reviewChangeKind: "replace",
				reviewDeletedText: "old text",
				reviewChangeActor: actor,
				reviewChangeAgent: actor ? "Codex" : undefined,
				anchor: { path: [0, 0], offset: 0 },
				focus: { path: [0, 0], offset: 8 },
			},
		];
		editor.setOption(
			ReviewAnchorPlugin,
			"snapshot",
			buildReviewSnapshot(editor, ranges),
		);
		const render = () =>
			renderToStaticMarkup(
				createElement(Plate, { editor }, createElement(PlateContent)),
			);
		const markup = render();
		expect(markup).toMatch(
			/<del[^>]*contenteditable="false"[^>]*class="review-change-delete/i,
		);
		expect(markup).toContain('<ins class="review-change-insert">');
		expect(markup.match(/old text/g)).toHaveLength(1);
		expect(NodeApi.string(editor)).toBe("new text");
		editor.setOption(
			ReviewAnchorPlugin,
			"snapshot",
			buildReviewSnapshot(editor, ranges, {
				view: { changesVisible: false, hues: new Map(), focus: null },
			}),
		);
		const clean = render();
		expect(clean).not.toContain("<ins");
		expect(clean).not.toContain("<del");
		expect(clean).toContain("new text");
		expect(NodeApi.string(editor)).toBe("new text");
	});
	it("renders indexed ranges through Plate into the actual review leaves", () => {
		const editor = createPlateEditor({
			plugins: [ReviewAnchorPlugin],
			value: [
				{ type: "p", children: [{ text: "first" }] },
				{ type: "p", children: [{ text: "second" }] },
			],
		});
		editor.setOption(
			ReviewAnchorPlugin,
			"snapshot",
			buildReviewSnapshot(editor, [
				{
					reviewAnchor: true,
					anchorId: "cross-block",
					anchor: { path: [0, 0], offset: 2 },
					focus: { path: [1, 0], offset: 3 },
				},
			]),
		);
		const html = renderToStaticMarkup(
			createElement(Plate, { editor }, createElement(PlateContent)),
		);
		expect(html.match(/data-review-anchor-id="cross-block"/g)).toHaveLength(2);
		expect(html).toContain("rst");
		expect(html).toContain("sec");
	});
	it("drops a bucket once its node changed, keeping untouched paragraphs", () => {
		const editor = createPlateEditor({
			plugins: [ReviewAnchorPlugin],
			value: [
				{ type: "p", children: [{ text: "first" }] },
				{ type: "p", children: [{ text: "second" }] },
			],
		});
		editor.setOption(
			ReviewAnchorPlugin,
			"snapshot",
			buildReviewSnapshot(editor, [
				{
					reviewAnchor: true,
					anchorId: "a",
					anchor: { path: [0, 0], offset: 0 },
					focus: { path: [0, 0], offset: 2 },
				},
				{
					reviewAnchor: true,
					anchorId: "b",
					anchor: { path: [1, 0], offset: 0 },
					focus: { path: [1, 0], offset: 2 },
				},
			]),
		);
		editor.tf.insertText("!", { at: { path: [1, 0], offset: 6 } });
		const html = renderToStaticMarkup(
			createElement(Plate, { editor }, createElement(PlateContent)),
		);
		expect(html).toContain('data-review-anchor-id="a"');
		expect(html).not.toContain('data-review-anchor-id="b"');
	});
	it("keeps nested/marked text, backward and overlapping ranges on the same leaves", () => {
		const editor = createSlateEditor({
			value: [
				{ type: "p", children: [{ text: "first" }] },
				{
					type: "blockquote",
					children: [
						{
							type: "p",
							children: [{ text: "plain" }, { text: "bold", bold: true }],
						},
					],
				},
			],
		});
		const ranges: ReviewAnchorRange[] = [
			{
				anchorId: "comment",
				reviewAnchor: true,
				anchor: { path: [1, 0, 0], offset: 2 },
				focus: { path: [1, 0, 1], offset: 3 },
			},
			{
				anchorId: "change",
				reviewChangeKind: "delete",
				reviewDeletedText: "old",
				anchor: { path: [1, 0, 1], offset: 3 },
				focus: { path: [1, 0, 1], offset: 1 },
			},
			{
				anchorId: "across",
				anchor: { path: [0, 0], offset: 1 },
				focus: { path: [1, 0, 0], offset: 2 },
			},
		];
		const index = indexReviewDecorations(ranges);
		expect([...index.values()].flat()).toHaveLength(ranges.length);
		for (const [, path] of NodeApi.texts(editor)) {
			const leafRange = editor.api.range(path) as TRange;
			const clip = (items: ReviewAnchorRange[]) =>
				items
					.flatMap((range) => {
						const intersection = RangeApi.intersection(range, leafRange);
						return intersection ? [{ ...range, ...intersection }] : [];
					})
					.sort((a, b) => a.anchorId.localeCompare(b.anchorId));
			const inherited = path.flatMap(
				(_, depth) => index.get(path.slice(0, depth).join(".")) ?? [],
			);
			expect(clip(inherited)).toEqual(clip(ranges));
		}
	});

	it("visits only local ranges instead of all revisions per paragraph", () => {
		const ranges = Array.from(
			{ length: 1000 },
			(_, i): ReviewAnchorRange => ({
				anchorId: `change-${i}`,
				reviewChangeKind: "insert",
				anchor: { path: [i, 0], offset: 0 },
				focus: { path: [i, 0], offset: 3 },
			}),
		);
		const index = indexReviewDecorations(ranges);
		let visited = 0;
		for (let i = 0; i < 1000; i++) visited += index.get(String(i))?.length ?? 0;
		expect(visited).toBe(1000); // previously 1000 * 1000 candidates
		expect(index.get("500.0")).toBeUndefined(); // no duplicate at a text leaf
	});

	it("colors each Agent and focuses on one Agent's work", () => {
		const range = (anchorId: string, extra: Partial<ReviewAnchorRange>) =>
			({
				anchorId,
				anchor: { path: [0, 0], offset: 0 },
				focus: { path: [0, 0], offset: 1 },
				...extra,
			}) as ReviewAnchorRange;
		const ranges = [
			range("chg-0-0", {
				reviewChangeKind: "insert",
				reviewChangeActor: "agent",
				reviewChangeAgent: "Codex",
			}),
			range("chg-0-1", { reviewChangeKind: "insert" }),
			range("c-codex", {}),
			range("c-mine", {}),
		];
		const hues = new Map([["Codex", "violet" as const]]);
		const all = presentRanges(ranges, {
			changesVisible: true,
			hues,
			focus: null,
		});
		expect(all[0].reviewChangeHue).toBe("violet");
		expect(all.map((r) => r.reviewChangeVisible)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		const focused = presentRanges(ranges, {
			changesVisible: true,
			hues,
			focus: { agent: "Codex", commentIds: new Set(["c-codex"]) },
		});
		expect(focused.map((r) => [r.anchorId, r.reviewChangeVisible])).toEqual([
			["chg-0-0", undefined],
			["chg-0-1", false],
			["c-codex", undefined],
		]);
	});
});
