/**
 * Word-style comment ranges. A comment is stored as its quote and context,
 * which an edit to the quoted words would make unfindable ("outdated"). While
 * a review is open, each placed comment also holds a Slate range ref, which
 * Slate moves through every edit; the text the range then covers is the
 * comment's new quote, shown at once and saved with the edit.
 *
 * A reload from disk replaces the blocks it changed (`applyValueDiff`),
 * which clears the refs in them; those comments are then placed again from
 * their (Agent-updated) quotes.
 */

import type { RangeRef, SlateEditor, TRange } from "platejs";
import { NodeApi, PathApi, RangeApi } from "platejs";
import type { CommentAnchor, ReviewComment } from "@/lib/core/bindings";
import type { ReviewAnchorRange } from "@/lib/review/anchor";

/** Characters of context kept on each side of a quote. */
export const QUOTE_CONTEXT_CHARS = 32;

export type CommentRefs = Map<string, RangeRef>;

/** The quote and context `range` covers, if it lies within one block. */
export function quoteAt(
	editor: SlateEditor,
	range: TRange,
): Omit<CommentAnchor, "commentId"> | null {
	const [start, end] = RangeApi.edges(range);
	const entry = editor.api.block({ at: start });
	if (!entry || !PathApi.isAncestor(entry[1], end.path)) return null;
	const [node, path] = entry;
	const blockStart = editor.api.start(path);
	if (!blockStart) return null;
	const raw = editor.api.string({ anchor: start, focus: end });
	const quote = raw.trim();
	if (!quote) return null;
	const at =
		editor.api.string({ anchor: blockStart, focus: start }).length +
		raw.length -
		raw.trimStart().length;
	const text = NodeApi.string(node);
	return {
		quote,
		prefix: text.slice(Math.max(0, at - QUOTE_CONTEXT_CHARS), at),
		suffix: text.slice(
			at + quote.length,
			at + quote.length + QUOTE_CONTEXT_CHARS,
		),
	};
}

/** Comments whose tracked range now covers other text than their quote. An
 * emptied range (the quoted words all deleted) moves nothing. */
export function movedCommentAnchors(
	editor: SlateEditor,
	comments: readonly ReviewComment[],
	refs: CommentRefs,
): CommentAnchor[] {
	const moved: CommentAnchor[] = [];
	for (const comment of comments) {
		const range = refs.get(comment.id)?.current;
		if (!range || RangeApi.isCollapsed(range)) continue;
		const at = quoteAt(editor, range);
		if (at && at.quote !== comment.quote)
			moved.push({ commentId: comment.id, ...at });
	}
	return moved;
}

/** `comments` with their moved quotes, to place them before the save does. */
export function withMovedAnchors(
	comments: readonly ReviewComment[],
	moved: readonly CommentAnchor[],
): readonly ReviewComment[] {
	if (!moved.length) return comments;
	const byId = new Map(moved.map((anchor) => [anchor.commentId, anchor]));
	return comments.map((comment) => {
		const anchor = byId.get(comment.id);
		return anchor
			? {
					...comment,
					quote: anchor.quote,
					prefix: anchor.prefix ?? "",
					suffix: anchor.suffix ?? "",
					anchor: "attached",
				}
			: comment;
	});
}

/** Track every placed comment from where its quote was found. A comment not
 * found keeps its ref, which holds where the edit took its text. */
export function syncCommentRefs(
	editor: SlateEditor,
	refs: CommentRefs,
	comments: readonly ReviewComment[],
	ranges: readonly ReviewAnchorRange[],
): void {
	const ids = new Set(comments.map((comment) => comment.id));
	for (const [id, ref] of refs) {
		if (ids.has(id)) continue;
		ref.unref();
		refs.delete(id);
	}
	for (const range of ranges) {
		if (!range.reviewAnchor || !ids.has(range.anchorId)) continue;
		const ref = refs.get(range.anchorId);
		if (ref?.current && RangeApi.equals(ref.current, range)) continue;
		ref?.unref();
		refs.set(
			range.anchorId,
			editor.api.rangeRef(
				{ anchor: range.anchor, focus: range.focus },
				{ affinity: "inward" },
			),
		);
	}
}
