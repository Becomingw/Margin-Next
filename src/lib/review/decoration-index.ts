import { NodeApi, type Path, type SlateEditor } from "platejs";
import type { ReviewComment, ReviewEvent } from "@/lib/core/bindings";
import type { AgentHue } from "./agents";
import type { AlignedBlock, ReviewAnchorRange } from "./anchor";

/** How the review marks are shown: clean mode, Agent colors, and an optional
 * focus on one Agent (only its revisions and its comment threads). */
export type ReviewDecorationView = {
	changesVisible: boolean;
	hues: ReadonlyMap<string, AgentHue>;
	focus: { agent: string; commentIds: ReadonlySet<string> } | null;
};

const DEFAULT_VIEW: ReviewDecorationView = {
	changesVisible: true,
	hues: new Map(),
	focus: null,
};

/** Apply the view to computed ranges (color, visibility, focus). */
export function presentRanges(
	ranges: readonly ReviewAnchorRange[],
	view: ReviewDecorationView,
): ReviewAnchorRange[] {
	const out: ReviewAnchorRange[] = [];
	for (const range of ranges) {
		if (!range.reviewChangeKind) {
			if (!view.focus || view.focus.commentIds.has(range.anchorId)) {
				out.push(range);
			}
			continue;
		}
		const agent = range.reviewChangeAgent;
		const hue = agent ? view.hues.get(agent) : undefined;
		const visible =
			view.changesVisible && (!view.focus || agent === view.focus.agent);
		out.push(
			hue || !visible
				? {
						...range,
						...(hue ? { reviewChangeHue: hue } : {}),
						...(visible ? {} : { reviewChangeVisible: false }),
					}
				: range,
		);
	}
	return out;
}

/** Attach each decoration once, at the lowest common ancestor of its text
 * endpoints. Slate clips and propagates it to descendants. Returning the whole
 * document's ranges at every node repeats that work on every caret movement.
 */
export function indexReviewDecorations(
	ranges: readonly ReviewAnchorRange[],
): Map<string, ReviewAnchorRange[]> {
	const index = new Map<string, ReviewAnchorRange[]>();
	for (const range of ranges) {
		const a = range.anchor.path;
		const b = range.focus.path;
		let depth = 0;
		while (depth < Math.min(a.length, b.length) && a[depth] === b[depth])
			depth++;
		// A single text leaf's range belongs to its parent, not the leaf itself.
		depth = Math.min(depth, a.length - 1, b.length - 1);
		const key = decorationPathKey(a.slice(0, Math.max(0, depth)));
		const bucket = index.get(key);
		if (bucket) bucket.push(range);
		else index.set(key, [range]);
	}
	return index;
}

export function decorationPathKey(path: Path): string {
	return path.join(".");
}

/** A live paragraph from the last full pass: the node it was computed for,
 * its sibling count (a moved paragraph is not the same one), and what it is
 * compared with. */
export type SnapshotBlock = {
	node: unknown;
	siblings: number;
	liveIndex: number;
	base: string | null;
};

/** Decorations for the review plugin, each bucket tied to the node it was
 * computed for (see `ReviewAnchorPlugin.decorate`). A paragraph edited after
 * the snapshot is decorated live from `blocks` and the inputs below. */
export type ReviewDecorationSnapshot = {
	byPath: Map<string, ReviewAnchorRange[]>;
	nodes: Map<string, unknown>;
	blocks: Map<string, SnapshotBlock>;
	topCount: number;
	comments: readonly ReviewComment[];
	events: readonly ReviewEvent[];
	view: ReviewDecorationView;
};

export function buildReviewSnapshot(
	editor: SlateEditor,
	ranges: readonly ReviewAnchorRange[],
	live: {
		aligned?: readonly AlignedBlock[];
		comments?: readonly ReviewComment[];
		events?: readonly ReviewEvent[];
		view?: ReviewDecorationView;
	} = {},
): ReviewDecorationSnapshot {
	const view = live.view ?? DEFAULT_VIEW;
	const byPath = indexReviewDecorations(presentRanges(ranges, view));
	const nodes = new Map<string, unknown>();
	for (const key of byPath.keys()) {
		nodes.set(
			key,
			key === ""
				? editor.children
				: NodeApi.get(editor, key.split(".").map(Number)),
		);
	}
	const blocks = new Map<string, SnapshotBlock>();
	for (const block of live.aligned ?? []) {
		const parent =
			block.path.length > 1
				? NodeApi.get(editor, block.path.slice(0, -1))
				: null;
		blocks.set(decorationPathKey(block.path), {
			node: NodeApi.get(editor, block.path),
			siblings: siblingCount(editor, parent),
			liveIndex: block.liveIndex,
			base: block.base,
		});
	}
	return {
		byPath,
		nodes,
		blocks,
		topCount: editor.children.length,
		comments: live.comments ?? [],
		events: live.events ?? [],
		view,
	};
}

export function siblingCount(editor: SlateEditor, parent: unknown): number {
	const children = (parent as { children?: unknown[] } | null)?.children;
	return children ? children.length : editor.children.length;
}
