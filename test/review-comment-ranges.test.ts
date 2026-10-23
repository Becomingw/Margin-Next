import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor } from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import type { ReviewComment } from "@/lib/core/bindings";
import { computeReviewDecorations } from "@/lib/review/anchor";
import {
	type CommentRefs,
	movedCommentAnchors,
	syncCommentRefs,
} from "@/lib/review/comment-ranges";

const text = "Our method cuts memory by 40% everywhere.";

function setup() {
	const editor = createSlateEditor({ plugins: MarkdownKit });
	editor.children = editor.getApi(MarkdownPlugin).markdown.deserialize(text);
	const comment = {
		id: "c-1",
		quote: "cuts memory by 40%",
		prefix: "Our method ",
		suffix: " everywhere.",
		status: "open",
		anchor: "attached",
		source: "manuscript",
		replies: [],
	} as unknown as ReviewComment;
	const refs: CommentRefs = new Map();
	const { ranges } = computeReviewDecorations(editor, [comment], text, []);
	syncCommentRefs(editor, refs, [comment], ranges);
	const at = (offset: number) => ({ path: [0, 0], offset });
	return { editor, comment, refs, at };
}

describe("Word-style comment ranges", () => {
	it("follow the author's edits inside the quoted words", () => {
		const { editor, comment, refs, at } = setup();
		editor.tf.insertText("peak ", { at: at(16) });
		const forty = text.indexOf("40") + "peak ".length;
		editor.tf.delete({ at: { anchor: at(forty), focus: at(forty + 2) } });
		editor.tf.insertText("38", { at: at(forty) });
		expect(movedCommentAnchors(editor, [comment], refs)).toEqual([
			{
				commentId: "c-1",
				quote: "cuts peak memory by 38%",
				prefix: "Our method ",
				suffix: " everywhere.",
			},
		]);
	});

	it("leave a comment alone when its words are deleted or untouched", () => {
		const { editor, comment, refs, at } = setup();
		editor.tf.insertText("Indeed, ", { at: at(0) });
		expect(movedCommentAnchors(editor, [comment], refs)).toEqual([]);
		const start = "Indeed, Our method ".length;
		editor.tf.delete({
			at: { anchor: at(start), focus: at(start + comment.quote.length) },
		});
		expect(movedCommentAnchors(editor, [comment], refs)).toEqual([]);
	});
});
