import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor } from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import {
	computeReviewDecorations,
	computeTrackedChanges,
	rejectTrackedChange,
} from "@/lib/review/anchor";

describe("review revisions in a long manuscript", () => {
	it("attributes only an unambiguous, still-current AI edit", () => {
		const baseline = "The old result is cited.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("The new result is cited.");
		const event = {
			id: "e-ai",
			kind: "edit",
			actor: "agent",
			createdAt: "2026-10-15T00:00:00Z",
			before: "old",
			after: "new",
		};
		const result = computeReviewDecorations(editor, [], baseline, [event]);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].actor).toBe("agent");
		expect(
			result.ranges.find((r) => r.reviewChangeKind)?.reviewChangeActor,
		).toBe("agent");
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("The newer result is cited.");
		expect(
			computeReviewDecorations(editor, [], baseline, [event]).changes[0].actor,
		).toBeUndefined();
	});
	it("credits one AI edit that rewrote several paragraphs", () => {
		const baseline =
			"Intro stays here.\n\nThe first old paragraph is long enough.\n\nThe second old paragraph is long too.\n\n## Old heading text\n\nOutro stays.";
		const current =
			"Intro stays here.\n\nThe first new paragraph is long enough.\n\nA rewritten second paragraph, quite long.\n\n## New heading text\n\nOutro stays.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(current);
		const event = {
			id: "e-ai",
			kind: "edit",
			actor: "agent",
			agent: "Gemini",
			createdAt: "2026-10-19T00:00:00Z",
			before:
				"old paragraph is long enough.\n\nThe second old paragraph is long too.\n\n## Old",
			after:
				"new paragraph is long enough.\n\nA rewritten second paragraph, quite long.\n\n## New",
			prefix: "The first ",
			suffix: " heading text",
		};
		const { changes } = computeReviewDecorations(editor, [], baseline, [event]);
		expect(changes.length).toBeGreaterThanOrEqual(3);
		for (const change of changes) expect(change.actor).toBe("agent");
	});
	it("credits AI edits whose saved Markdown escapes citation brackets", () => {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("Claims rest on \\[1] and newer trials \\[2].");
		const event = {
			id: "e-ai",
			kind: "edit",
			actor: "agent",
			agent: "Gemini",
			createdAt: "2026-10-19T00:00:00Z",
			before: "alone",
			after: "and newer trials \\[2]",
			prefix: "Claims rest on \\[1] ",
			suffix: ".",
		};
		const { changes } = computeReviewDecorations(
			editor,
			[],
			"Claims rest on \\[1] alone.",
			[event],
		);
		expect(changes.length).toBeGreaterThan(0);
		for (const change of changes) expect(change.actor).toBe("agent");
	});
	it("credits the surviving AI rewrite even after a human changed the baseline text", () => {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("The new result is cited.");
		const event = {
			id: "e-ai",
			kind: "edit",
			actor: "agent",
			createdAt: "2026-10-15T00:00:00Z",
			before: "revised",
			after: "new",
			prefix: "The ",
			suffix: " result is cited.",
		};
		const changes = computeReviewDecorations(
			editor,
			[],
			"The old result is cited.",
			[event],
		).changes;
		expect(changes[0].actor).toBe("agent");
	});
	it("uses local context to distinguish identical human and AI revisions", () => {
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("A new text.\n\nB new text.");
		const changes = computeReviewDecorations(
			editor,
			[],
			"A old text.\n\nB old text.",
			[
				{
					id: "e-ai",
					kind: "edit",
					actor: "agent",
					createdAt: "2026-10-15T00:00:00Z",
					before: "old",
					after: "new",
					prefix: "B ",
					suffix: " text.",
				},
			],
		).changes;
		expect(changes.map((change) => change.actor)).toEqual([undefined, "agent"]);
	});
	it("attributes an AI punctuation deletion inside Markdown emphasis", () => {
		const baseline =
			"_说明：本稿为中文 V2，。图暂未加入，正文中的图 1–7 为预留位置。_";
		const current =
			"_说明：本稿为中文 V2。图暂未加入，正文中的图 1–7 为预留位置。_";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(current);
		const aiEdit = {
			id: "e-ai-punctuation",
			kind: "edit",
			actor: "agent",
			createdAt: "2026-10-15T00:00:00Z",
			before: "，",
			after: "",
			prefix: "_说明：本稿为中文 V2",
			suffix: "。图暂未加入，正文中的图 1–7 为预留位置。_",
		};
		const result = computeReviewDecorations(editor, [], baseline, [aiEdit]);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0].actor).toBe("agent");
		expect(
			result.ranges.find((r) => r.reviewChangeKind)?.reviewChangeActor,
		).toBe("agent");
		const humanEdit = {
			...aiEdit,
			id: "e-human-punctuation",
			actor: "author",
			prefix: undefined,
			suffix: undefined,
		};
		const afterHumanRewrite = computeReviewDecorations(editor, [], baseline, [
			aiEdit,
			humanEdit,
		]);
		expect(afterHumanRewrite.changes[0].actor).toBeUndefined();
	});
	it("rejects only the selected insertion without replacing the document", () => {
		const manuscript = Array.from(
			{ length: 250 },
			(_, i) =>
				`## Section ${i}\n\nParagraph ${i} with evidence and a conclusion.`,
		).join("\n\n");
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(prepareMarkdownForDeserialize(manuscript));
		expect(computeTrackedChanges(editor, manuscript).changes).toHaveLength(0);

		const paragraph = editor.children.find(
			(node) =>
				node.type === "p" &&
				JSON.stringify(node).includes("Paragraph 125 with evidence"),
		);
		expect(paragraph).toBeDefined();
		if (!paragraph) throw new Error("Missing paragraph fixture");
		const index = editor.children.indexOf(paragraph);
		editor.tf.insertText("important ", {
			at: { path: [index, 0], offset: 19 },
		});
		const secondIndex = editor.children.findIndex(
			(node) =>
				node.type === "p" &&
				JSON.stringify(node).includes("Paragraph 200 with evidence"),
		);
		editor.tf.insertText("additional ", {
			at: { path: [secondIndex, 0], offset: 19 },
		});
		const { changes } = computeTrackedChanges(editor, manuscript);
		expect(changes).toHaveLength(2);
		const otherNode = editor.children[10];
		const before = editor.children;
		expect(rejectTrackedChange(editor, manuscript, changes[0])).toBe(true);
		expect(editor.children).not.toBe(before);
		expect(editor.children[10]).toBe(otherNode);
		expect(computeTrackedChanges(editor, manuscript).changes).toHaveLength(1);
		expect(rejectTrackedChange(editor, manuscript, changes[0])).toBe(false);
	});

	it("restores a removed paragraph as a separate block", () => {
		const baseline = "First paragraph.\n\nMiddle paragraph.\n\nLast paragraph.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(baseline);
		editor.tf.removeNodes({ at: [1] });
		const changes = computeTrackedChanges(editor, baseline).changes;
		expect(changes).toHaveLength(1);
		expect(rejectTrackedChange(editor, baseline, changes[0])).toBe(true);
		expect(editor.children).toHaveLength(3);
		expect(computeTrackedChanges(editor, baseline).changes).toHaveLength(0);
	});

	it("rejects an added paragraph without touching its neighbors", () => {
		const baseline = "First paragraph.\n\nLast paragraph.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(baseline);
		editor.tf.insertNodes(
			{ type: "p", children: [{ text: "Added paragraph." }] },
			{ at: [1] },
		);
		const changes = computeTrackedChanges(editor, baseline).changes;
		expect(changes).toHaveLength(1);
		expect(rejectTrackedChange(editor, baseline, changes[0])).toBe(true);
		expect(editor.children).toHaveLength(2);
		expect(computeTrackedChanges(editor, baseline).changes).toHaveLength(0);
	});

	it("keeps several removed paragraphs and a removed last paragraph as deletions", () => {
		const baseline =
			"Intro.\n\nGone one.\n\nGone two.\n\nKept.\n\nTail removed.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("Intro.\n\nKept.");
		const changes = computeTrackedChanges(editor, baseline).changes;
		expect(changes.map((c) => c.blockDeletion)).toEqual([
			{ blocks: ["Gone one.", "Gone two."], position: "before" },
			{ blocks: ["Tail removed."], position: "after" },
		]);
		expect(rejectTrackedChange(editor, baseline, changes[1])).toBe(true);
		expect(rejectTrackedChange(editor, baseline, changes[0])).toBe(true);
		expect(computeTrackedChanges(editor, baseline).changes).toHaveLength(0);
	});

	it("shows a deletion at the end of a paragraph after its last character", () => {
		const baseline = "Results hold in all settings.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("Results hold");
		const { ranges } = computeReviewDecorations(editor, [], baseline);
		const carrier = ranges.find((r) => r.reviewDeletedText);
		expect(carrier?.reviewDeletedText).toBe(" in all settings.");
		expect(carrier?.reviewDeletedAfter).toBe(true);
		expect(carrier?.focus.offset).toBe("Results hold".length);
		const [change] = computeTrackedChanges(editor, baseline).changes;
		expect(rejectTrackedChange(editor, baseline, change)).toBe(true);
		expect(computeTrackedChanges(editor, baseline).changes).toHaveLength(0);
	});

	it("renders replaced text once even when the new text spans formatting", () => {
		const baseline = "We use a small model here.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("We use a **much larger** model here.");
		const { ranges } = computeReviewDecorations(editor, [], baseline);
		expect(ranges.filter((r) => r.reviewDeletedText)).toHaveLength(1);
	});

	it("groups a multi-word AI rewrite and credits it and an AI paragraph deletion", () => {
		const baseline =
			"Method text.\n\nWe cache router scores.\n\nResults hold across all model sizes we tested.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(
				"Method text.\n\nResults hold for the 125M to 1.3B models we tested.",
			);
		const at = "2026-10-15T00:00:00Z";
		const changes = computeReviewDecorations(editor, [], baseline, [
			{
				id: "e-rewrite",
				kind: "edit",
				actor: "agent",
				createdAt: at,
				// As the Host records it: characters shared with the old text
				// ("model|s we tested.") stay outside the edit.
				before: "across all model size",
				after: "for the 125M to 1.3B model",
				prefix: "Results hold ",
				suffix: "s we tested.",
			},
			{
				id: "e-drop",
				kind: "edit",
				actor: "agent",
				createdAt: at,
				before: "We cache router scores.\n\n",
				after: "",
				prefix: "",
				suffix: "Results hold",
			},
		]).changes;
		expect(changes.map((c) => [c.before, c.after, c.actor])).toEqual([
			["We cache router scores.", "", "agent"],
			["across all model sizes", "for the 125M to 1.3B models", "agent"],
		]);
	});

	it("keeps an AI paragraph deletion credited after unrelated author deletions", () => {
		const baseline = "Kept intro.\n\nDropped by AI.\n\nEnding sentence here.";
		const editor = createSlateEditor({ plugins: MarkdownKit });
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize("Kept intro.\n\nEnding sentence here.");
		const at = "2026-10-15T00:00:00Z";
		const [change] = computeReviewDecorations(editor, [], baseline, [
			{
				id: "e-ai",
				kind: "edit",
				actor: "agent",
				createdAt: at,
				before: "Dropped by AI.\n\n",
				after: "",
			},
			{
				id: "e-me",
				kind: "edit",
				actor: "author",
				createdAt: at,
				before: "s",
				after: "",
			},
		]).changes;
		expect(change.blockDeletion).toBeDefined();
		expect(change.actor).toBe("agent");
	});
});
