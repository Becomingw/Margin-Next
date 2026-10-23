/**
 * Editor-side anchor & Track Changes resolution for the Word-style Review
 * workspace.
 *
 * 1. Maps review comments (`quote` + `prefix`/`suffix`) to Plate decoration
 *    ranges over the live document without polluting Markdown with `^block-id`.
 * 2. Computes inline word/character-level Tracked Changes (`insert`, `delete`,
 *    `replace`) between the round baseline text and the live editor blocks so
 *    insertions (underlined) and deletions (strikethrough) render inline and
 *    can be individually Accepted or Rejected.
 */

import type { Path, SlateEditor, TElement, TNode, TRange } from "platejs";
import { ElementApi, NodeApi } from "platejs";
import type { ReviewComment, ReviewEvent } from "@/lib/core/bindings";
import {
	normalizeHtmlWrappedMarkdown,
	prepareMarkdownForDeserialize,
} from "@/lib/markdown/deserialize";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import type { AgentHue } from "@/lib/review/agents";

export type TrackedChangeKind = "insert" | "delete" | "replace";

export type TrackedChange = {
	id: string;
	kind: TrackedChangeKind;
	actor?: "agent";
	/** Which Agent wrote it, when several review the same manuscript. */
	agentName?: string;
	/** Deleted text (empty for pure insertions). */
	before: string;
	/** Inserted text (empty for pure deletions). */
	after: string;
	/** Full baseline line/block before this change. */
	baselineBlock: string;
	/** Full current line/block containing this change. */
	currentBlock: string;
	/** Index of the matched block in the baseline paragraphs. */
	baselineBlockIndex: number;
	/** Index of the block in the live editor leaf blocks. */
	currentBlockIndex: number;
	/** Character offset within `currentBlock` where `after` starts. */
	charOffset: number;
	/** In-paragraph deletion at the end: shown after the last character. */
	deletedAfter?: boolean;
	/** Whole baseline paragraphs removed before / after this live paragraph. */
	blockDeletion?: { blocks: string[]; position: "before" | "after" };
};

export type ReviewAnchorRange = TRange & {
	reviewAnchor?: boolean;
	anchorId: string;
	anchorStatus?: "attached" | "modified";
	active?: boolean;
	reviewChangeKind?: TrackedChangeKind;
	reviewDeletedText?: string;
	/** Where deleted text renders relative to the anchored character. */
	reviewDeletedAfter?: boolean;
	/** Deleted whole paragraphs render as their own struck-through lines. */
	reviewDeletedBlock?: boolean;
	reviewChangeVisible?: boolean;
	reviewChangeActor?: "agent";
	reviewChangeAgent?: string;
	/** The writing Agent's color (see `agents.ts`). */
	reviewChangeHue?: AgentHue;
};

type LeafBlock = {
	path: Path;
	text: string;
	stripped: string;
	id: string | null;
};

const BLOCK_ID_TAIL = /\s\^([A-Za-z0-9_-]+)\s*$/;

function isLeafBlock(editor: SlateEditor, node: TNode): node is TElement {
	return (
		ElementApi.isElement(node) &&
		editor.api.isBlock(node) &&
		!node.children.some(
			(child) => ElementApi.isElement(child) && editor.api.isBlock(child),
		)
	);
}

export function collectBlocks(editor: SlateEditor): LeafBlock[] {
	const blocks: LeafBlock[] = [];
	for (const [node, path] of editor.api.nodes<TElement>({
		at: [],
		match: (n) => isLeafBlock(editor, n),
	})) {
		const text = NodeApi.string(node);
		const match = BLOCK_ID_TAIL.exec(text);
		const id = match ? match[1] : null;
		const stripped = match ? text.slice(0, match.index).trimEnd() : text;
		blocks.push({ id, path, stripped, text });
	}
	return blocks;
}

/** Strip leading Markdown block syntax (`# `, `> `, `- `, `1. `) for plain-text comparison. */
function stripMarkdownBlockPrefix(line: string): string {
	return line
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s+/, "")
		.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(BLOCK_ID_TAIL, "")
		.trimEnd();
}

/** Extract non-empty logical blocks from raw Markdown (skipping frontmatter). */
export function splitMarkdownLogicalBlocks(markdown: string): string[] {
	const normalized = normalizeHtmlWrappedMarkdown(markdown);
	const withoutFm = normalized.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	const lines = withoutFm.split(/\r?\n/);
	const out: string[] = [];
	for (const raw of lines) {
		const trimmed = raw.trim();
		if (
			!trimmed ||
			/^```/.test(trimmed) ||
			/^---+$/.test(trimmed) ||
			/^\$\$$/.test(trimmed) ||
			/^\|[\s:|-]+\|$/.test(trimmed)
		) {
			continue;
		}
		out.push(stripMarkdownBlockPrefix(raw));
	}
	return out;
}

/** Split text into fine tokens: words, single CJK characters, whitespace
 * runs and single punctuation marks ("40%." is "40", "%", "."), so an edit
 * next to punctuation does not drag the punctuation into the change. */
function tokenizeFine(text: string): string[] {
	return (
		text.match(
			/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g,
		) ?? []
	);
}

type FineDiffOp = {
	kind: TrackedChangeKind;
	before: string;
	after: string;
	afterOffset: number;
};

/** Compute token-level diff operations within a single paragraph. */
function diffParagraphTokens(oldText: string, newText: string): FineDiffOp[] {
	if (oldText === newText) return [];
	const a = tokenizeFine(oldText);
	const b = tokenizeFine(newText);
	// Guard against quadratic blowup on huge paragraphs: fall back to prefix/suffix span.
	if (a.length * b.length > 40_000) {
		let p = 0;
		while (
			p < oldText.length &&
			p < newText.length &&
			oldText[p] === newText[p]
		) {
			p++;
		}
		let sOld = oldText.length;
		let sNew = newText.length;
		while (sOld > p && sNew > p && oldText[sOld - 1] === newText[sNew - 1]) {
			sOld--;
			sNew--;
		}
		const before = oldText.slice(p, sOld);
		const after = newText.slice(p, sNew);
		return [
			{
				kind: before && after ? "replace" : before ? "delete" : "insert",
				before,
				after,
				afterOffset: p,
			},
		];
	}

	const n = a.length;
	const m = b.length;
	const dp = new Uint16Array((n + 1) * (m + 1));
	const w = m + 1;
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * w + j] =
				a[i] === b[j]
					? dp[(i + 1) * w + (j + 1)] + 1
					: Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
		}
	}

	const raw: Array<{ type: "eq" | "del" | "ins"; text: string }> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			raw.push({ type: "eq", text: a[i] });
			i++;
			j++;
		} else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
			raw.push({ type: "del", text: a[i] });
			i++;
		} else {
			raw.push({ type: "ins", text: b[j] });
			j++;
		}
	}
	while (i < n) raw.push({ type: "del", text: a[i++] });
	while (j < m) raw.push({ type: "ins", text: b[j++] });

	// A rewrite of several words reads as one struck phrase and one new
	// phrase, not alternating word pairs: spaces between changed words join
	// the change.
	for (let r = 1; r < raw.length - 1; r++) {
		if (
			raw[r].type === "eq" &&
			/^\s+$/.test(raw[r].text) &&
			raw[r - 1].type !== "eq" &&
			raw[r + 1].type !== "eq"
		) {
			raw.splice(
				r,
				1,
				{ type: "del", text: raw[r].text },
				{
					type: "ins",
					text: raw[r].text,
				},
			);
			r++;
		}
	}

	// Coalesce adjacent del/ins runs into replace/insert/delete ops with char offsets in newText.
	const ops: FineDiffOp[] = [];
	let afterOffset = 0;
	let k = 0;
	while (k < raw.length) {
		if (raw[k].type === "eq") {
			afterOffset += raw[k].text.length;
			k++;
			continue;
		}
		let delBuf = "";
		let insBuf = "";
		while (k < raw.length && raw[k].type !== "eq") {
			if (raw[k].type === "del") delBuf += raw[k].text;
			else insBuf += raw[k].text;
			k++;
		}
		if (delBuf || insBuf) {
			// Spaces on both sides of a grouped rewrite are unchanged text.
			let lead = 0;
			while (
				lead < delBuf.length &&
				lead < insBuf.length &&
				delBuf[lead] === insBuf[lead] &&
				/\s/.test(delBuf[lead])
			)
				lead++;
			let tail = 0;
			while (
				tail < delBuf.length - lead &&
				tail < insBuf.length - lead &&
				delBuf[delBuf.length - 1 - tail] === insBuf[insBuf.length - 1 - tail] &&
				/\s/.test(delBuf[delBuf.length - 1 - tail])
			)
				tail++;
			const before = delBuf.slice(lead, delBuf.length - tail);
			const after = insBuf.slice(lead, insBuf.length - tail);
			if (before || after) {
				ops.push({
					kind: before && after ? "replace" : before ? "delete" : "insert",
					before,
					after,
					afterOffset: afterOffset + lead,
				});
			}
			afterOffset += insBuf.length;
		}
	}
	return ops;
}

/** Similarity score [0..1] between two paragraph strings for block alignment. */
function blockSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (!a || !b) return 0;
	const minLen = Math.min(a.length, b.length);
	const maxLen = Math.max(a.length, b.length);
	if (minLen / maxLen < 0.2) return 0;
	let commonPrefix = 0;
	while (commonPrefix < minLen && a[commonPrefix] === b[commonPrefix]) {
		commonPrefix++;
	}
	let commonSuffix = 0;
	while (
		commonSuffix < minLen - commonPrefix &&
		a[a.length - 1 - commonSuffix] === b[b.length - 1 - commonSuffix]
	) {
		commonSuffix++;
	}
	const edgeRatio = (commonPrefix + commonSuffix) / maxLen;
	if (edgeRatio >= 0.25) return edgeRatio;
	const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
	const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
	if (wordsA.size === 0 || wordsB.size === 0) return edgeRatio;
	let overlap = 0;
	for (const w of wordsA) {
		if (wordsB.has(w)) overlap++;
	}
	return overlap / Math.max(wordsA.size, wordsB.size);
}

const baselineBlockCache = new WeakMap<
	SlateEditor,
	{ raw: string; blocks: string[] }
>();

/**
 * Deserialize `baselineMarkdown` through the same Plate Markdown pipeline as
 * the live editor so tables, equations, lists, and HTML-wrapped Markdown
 * produce the exact same leaf-block sequence (zero false-positive diffs).
 */
function getBaselineBlocks(
	editor: SlateEditor,
	baselineMarkdown: string,
): string[] {
	const cached = baselineBlockCache.get(editor);
	if (cached && cached.raw === baselineMarkdown) {
		return cached.blocks;
	}
	try {
		const api = editor.api as unknown as {
			markdown?: { deserialize?: (md: string) => TNode[] };
		};
		const deserialize = api.markdown?.deserialize;
		if (typeof deserialize === "function") {
			const nodes = deserialize(
				prepareMarkdownForDeserialize(splitFrontmatter(baselineMarkdown).body),
			);
			const blocks: string[] = [];
			const walk = (list: TNode[]) => {
				for (const n of list) {
					if (isLeafBlock(editor, n)) {
						const text = NodeApi.string(n).replace(BLOCK_ID_TAIL, "").trimEnd();
						if (text.trim().length > 0) blocks.push(text);
					} else if (ElementApi.isElement(n) && n.children) {
						walk(n.children as TNode[]);
					}
				}
			};
			walk(nodes);
			baselineBlockCache.set(editor, { raw: baselineMarkdown, blocks });
			return blocks;
		}
	} catch {
		// Fall back to line-based block extraction if markdown api is unavailable.
	}
	const fallback = splitMarkdownLogicalBlocks(baselineMarkdown);
	baselineBlockCache.set(editor, { raw: baselineMarkdown, blocks: fallback });
	return fallback;
}

type AlignedPair =
	| { kind: "equal"; b: number; l: number }
	| { kind: "modified"; b: number; l: number }
	| { kind: "inserted"; l: number }
	| { kind: "deleted"; b: number };

/** Exact-match LCS above this many cells falls back to in-order hash matching. */
const BLOCK_LCS_LIMIT = 2_000_000;

/**
 * Align baseline and live paragraphs: unchanged paragraphs match exactly
 * (common prefix/suffix, then LCS), and the unmatched paragraphs between two
 * matches pair up as modified when they still resemble each other, otherwise
 * as deleted / inserted. Several removed paragraphs in a row, or removals at
 * the end of the document, stay deletions instead of turning into rewrites.
 */
function alignBlocks(base: string[], live: string[]): AlignedPair[] {
	let prefix = 0;
	while (
		prefix < base.length &&
		prefix < live.length &&
		base[prefix] === live[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < base.length - prefix &&
		suffix < live.length - prefix &&
		base[base.length - 1 - suffix] === live[live.length - 1 - suffix]
	)
		suffix++;
	const bEnd = base.length - suffix;
	const lEnd = live.length - suffix;
	const matches = matchMiddle(base, live, prefix, bEnd, prefix, lEnd);

	const pairs: AlignedPair[] = [];
	for (let i = 0; i < prefix; i++) pairs.push({ kind: "equal", b: i, l: i });
	let b = prefix;
	let l = prefix;
	for (const [mb, ml] of [...matches, [bEnd, lEnd] as const]) {
		pairGap(base, live, b, mb, l, ml, pairs);
		if (mb < bEnd) pairs.push({ kind: "equal", b: mb, l: ml });
		b = mb + 1;
		l = ml + 1;
	}
	for (let i = 0; i < suffix; i++)
		pairs.push({ kind: "equal", b: bEnd + i, l: lEnd + i });
	return pairs;
}

function matchMiddle(
	base: string[],
	live: string[],
	b0: number,
	b1: number,
	l0: number,
	l1: number,
): Array<readonly [number, number]> {
	const n = b1 - b0;
	const m = l1 - l0;
	if (n === 0 || m === 0) return [];
	if (n * m > BLOCK_LCS_LIMIT) {
		// Very large rewrites: match each paragraph to its next unused copy.
		const positions = new Map<string, number[]>();
		for (let j = l0; j < l1; j++) {
			const list = positions.get(live[j]);
			if (list) list.push(j);
			else positions.set(live[j], [j]);
		}
		const out: Array<readonly [number, number]> = [];
		let floor = l0;
		for (let i = b0; i < b1; i++) {
			const list = positions.get(base[i]);
			while (list?.length && list[0] < floor) list.shift();
			const j = list?.shift();
			if (j !== undefined) {
				out.push([i, j]);
				floor = j + 1;
			}
		}
		return out;
	}
	const w = m + 1;
	const dp = new Uint16Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * w + j] =
				base[b0 + i] === live[l0 + j]
					? dp[(i + 1) * w + j + 1] + 1
					: Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
		}
	}
	const out: Array<readonly [number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (base[b0 + i] === live[l0 + j]) {
			out.push([b0 + i, l0 + j]);
			i++;
			j++;
		} else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
		else j++;
	}
	return out;
}

function pairGap(
	base: string[],
	live: string[],
	b0: number,
	b1: number,
	l0: number,
	l1: number,
	out: AlignedPair[],
): void {
	let b = b0;
	let l = l0;
	while (b < b1 && l < l1) {
		const remB = b1 - b;
		const remL = l1 - l;
		if (blockSimilarity(base[b], live[l]) >= 0.3 || remB === remL) {
			out.push({ kind: "modified", b: b++, l: l++ });
		} else if (remB > remL) {
			out.push({ kind: "deleted", b: b++ });
		} else {
			out.push({ kind: "inserted", l: l++ });
		}
	}
	while (b < b1) out.push({ kind: "deleted", b: b++ });
	while (l < l1) out.push({ kind: "inserted", l: l++ });
}

/** Paragraph diffs keyed by their text pair: typing re-diffs one paragraph. */
const paragraphDiffCache = new Map<string, FineDiffOp[]>();
const PARAGRAPH_DIFF_CACHE_SIZE = 600;

function cachedParagraphDiff(oldText: string, newText: string): FineDiffOp[] {
	const key = `${oldText}\u0000${newText}`;
	const hit = paragraphDiffCache.get(key);
	if (hit) {
		paragraphDiffCache.delete(key);
		paragraphDiffCache.set(key, hit);
		return hit;
	}
	const ops = diffParagraphTokens(oldText, newText);
	paragraphDiffCache.set(key, ops);
	if (paragraphDiffCache.size > PARAGRAPH_DIFF_CACHE_SIZE) {
		const oldest = paragraphDiffCache.keys().next().value;
		if (oldest !== undefined) paragraphDiffCache.delete(oldest);
	}
	return ops;
}

/**
 * Compute inline Tracked Changes between `baselineMarkdown` and the live
 * Plate editor blocks.
 */
/** Changes inside one live paragraph aligned to baseline paragraph `bText`
 * (`null`: the paragraph is new). Shared by the full pass and by live
 * decoration of the paragraph being typed in, so both produce the same ids. */
function paragraphChanges(
	editor: SlateEditor,
	lBlock: LeafBlock,
	li: number,
	bText: string | null,
	bIndex: number,
): Array<[TrackedChange, TRange | null]> {
	const lText = lBlock.stripped;
	if (bText === null) {
		return [
			[
				{
					id: `chg-ins-${li}`,
					kind: "insert",
					before: "",
					after: lText,
					baselineBlock: "",
					currentBlock: lText,
					baselineBlockIndex: -1,
					currentBlockIndex: li,
					charOffset: 0,
				},
				toRange(editor, lBlock, 0, lText.length),
			],
		];
	}
	if (bText === lText) return [];
	if (blockSimilarity(bText, lText) < 0.15) {
		return [
			[
				{
					id: `chg-rep-${li}`,
					kind: "replace",
					before: bText,
					after: lText,
					baselineBlock: bText,
					currentBlock: lText,
					baselineBlockIndex: bIndex,
					currentBlockIndex: li,
					charOffset: 0,
				},
				toRange(editor, lBlock, 0, lText.length),
			],
		];
	}
	return cachedParagraphDiff(bText, lText).map((op, opIdx) => {
		// A deletion at the very end anchors to the last character and
		// renders after it; anywhere else it renders before the next one.
		const atEnd = op.after.length === 0 && op.afterOffset >= lText.length;
		const start =
			op.after.length > 0
				? op.afterOffset
				: atEnd
					? lText.length - 1
					: op.afterOffset;
		const len = op.after.length > 0 ? op.after.length : 1;
		return [
			{
				id: `chg-${li}-${opIdx}`,
				kind: op.kind,
				before: op.before,
				after: op.after,
				baselineBlock: bText,
				currentBlock: lText,
				baselineBlockIndex: bIndex,
				currentBlockIndex: li,
				charOffset: op.afterOffset,
				...(atEnd ? { deletedAfter: true } : {}),
			},
			toRange(editor, lBlock, start, len),
		];
	});
}

/** A live paragraph and the baseline text it is compared with (`null`: new). */
export type AlignedBlock = {
	path: Path;
	liveIndex: number;
	base: string | null;
};

export function computeTrackedChanges(
	editor: SlateEditor,
	baselineMarkdown: string | undefined,
): {
	changes: TrackedChange[];
	ranges: Map<string, TRange>;
	aligned: AlignedBlock[];
} {
	const changes: TrackedChange[] = [];
	const ranges = new Map<string, TRange>();
	const aligned: AlignedBlock[] = [];
	if (!baselineMarkdown?.trim()) return { changes, ranges, aligned };

	const baseBlocks = getBaselineBlocks(editor, baselineMarkdown);
	const liveBlocks = collectBlocks(editor).filter(
		(b) => b.stripped.trim().length > 0,
	);
	if (baseBlocks.length === 0 || liveBlocks.length === 0) {
		return { changes, ranges, aligned };
	}

	const push = (change: TrackedChange, range: TRange | null) => {
		if (!range) return;
		changes.push(change);
		ranges.set(change.id, range);
	};
	let pending: number[] = [];
	const flushDeleted = (li: number, position: "before" | "after") => {
		if (!pending.length) return;
		const block = liveBlocks[li];
		const blocks = pending.map((b) => baseBlocks[b]);
		const range =
			position === "before"
				? toRange(editor, block, 0, 1)
				: toRange(editor, block, Math.max(0, block.stripped.length - 1), 1);
		push(
			{
				id: position === "before" ? `chg-del-${li}` : "chg-del-end",
				kind: "delete",
				before: blocks.join("\n\n"),
				after: "",
				baselineBlock: blocks[0],
				currentBlock: block.stripped,
				baselineBlockIndex: pending[0],
				currentBlockIndex: li,
				charOffset: position === "before" ? 0 : block.stripped.length,
				blockDeletion: { blocks, position },
			},
			range,
		);
		pending = [];
	};

	for (const pair of alignBlocks(
		baseBlocks,
		liveBlocks.map((b) => b.stripped),
	)) {
		if (pair.kind === "deleted") {
			pending.push(pair.b);
			continue;
		}
		flushDeleted(pair.l, "before");
		const bText = pair.kind === "inserted" ? null : baseBlocks[pair.b];
		const bIndex = pair.kind === "inserted" ? -1 : pair.b;
		aligned.push({
			path: liveBlocks[pair.l].path,
			liveIndex: pair.l,
			base: bText,
		});
		if (pair.kind === "equal") continue;
		for (const [change, range] of paragraphChanges(
			editor,
			liveBlocks[pair.l],
			pair.l,
			bText,
			bIndex,
		)) {
			push(change, range);
		}
	}
	flushDeleted(liveBlocks.length - 1, "after");

	return { changes, ranges, aligned };
}

/** Reject a revision at its live Slate range, leaving the rest of the manuscript
 * (and the editor's scroll/caret state) untouched. The normal editor autosave
 * records this edit; a stale balloon is never allowed to edit a different span.
 */
export function rejectTrackedChange(
	editor: SlateEditor,
	baselineMarkdown: string,
	change: TrackedChange,
): boolean {
	const { changes, ranges } = computeTrackedChanges(editor, baselineMarkdown);
	const current = changes.find(
		(c) =>
			c.id === change.id &&
			c.before === change.before &&
			c.after === change.after &&
			c.currentBlock === change.currentBlock,
	);
	if (!current) return false;
	const range = ranges.get(current.id);
	if (!range) return false;
	const liveBlock = () => {
		const target = collectBlocks(editor).filter((b) => b.stripped.trim())[
			current.currentBlockIndex
		];
		return target?.stripped === current.currentBlock ? target : undefined;
	};
	if (current.blockDeletion) {
		const target = liveBlock();
		if (!target) return false;
		const at =
			current.blockDeletion.position === "before"
				? target.path
				: [...target.path.slice(0, -1), (target.path.at(-1) ?? 0) + 1];
		editor.tf.insertNodes(
			current.blockDeletion.blocks.map((text) => ({
				type: "p",
				children: [{ text }],
			})),
			{ at },
		);
	} else if (current.kind === "insert" && !current.baselineBlock) {
		const target = liveBlock();
		if (!target) return false;
		editor.tf.removeNodes({ at: target.path });
	} else if (current.kind === "delete") {
		editor.tf.insertText(current.before, {
			at: current.deletedAfter ? range.focus : range.anchor,
		});
	} else if (editor.api.string(range) === current.after) {
		if (current.before) {
			editor.tf.insertText(current.before, { at: range });
		} else {
			editor.tf.delete({ at: range });
		}
	} else {
		return false;
	}
	return true;
}

/**
 * Produce the updated baseline Markdown when the user Accepts a single
 * `TrackedChange` (so that single change becomes permanent baseline text).
 */
export function buildBaselineAfterAcceptSingle(
	baselineMarkdown: string,
	currentMarkdown: string,
	change: TrackedChange,
): string {
	if (change.blockDeletion) {
		let next = baselineMarkdown;
		for (const block of change.blockDeletion.blocks) {
			if (!next.includes(block)) return currentMarkdown;
			next = next.replace(block, "");
		}
		return next.replace(/\n{3,}/g, "\n\n");
	}
	if (change.kind === "insert" && !change.baselineBlock) {
		return currentMarkdown;
	}
	if (change.baselineBlock && change.currentBlock) {
		const nextBlock =
			change.before && change.baselineBlock.includes(change.before)
				? change.baselineBlock.replace(change.before, change.after)
				: change.currentBlock;
		if (baselineMarkdown.includes(change.baselineBlock)) {
			return baselineMarkdown.replace(change.baselineBlock, nextBlock);
		}
	}
	if (change.before && baselineMarkdown.includes(change.before)) {
		return baselineMarkdown.replace(change.before, change.after);
	}
	return currentMarkdown;
}

/**
 * Produce the updated manuscript Markdown when the user Rejects a single
 * `TrackedChange` (reverting that change back to its baseline text).
 */
export function buildManuscriptAfterRejectSingle(
	currentMarkdown: string,
	baselineMarkdown: string,
	change: TrackedChange,
): string {
	if (change.kind === "insert" && !change.baselineBlock) {
		return currentMarkdown.replace(change.after, "");
	}
	if (change.kind === "delete" && !change.after) {
		if (change.currentBlock && currentMarkdown.includes(change.currentBlock)) {
			const idx = currentMarkdown.indexOf(change.currentBlock);
			const prefix = currentMarkdown.slice(0, idx);
			const rest = currentMarkdown.slice(idx);
			const restored =
				change.charOffset === 0
					? `${change.before}${change.currentBlock}`
					: `${change.currentBlock.slice(0, change.charOffset)}${change.before}${change.currentBlock.slice(change.charOffset)}`;
			return prefix + rest.replace(change.currentBlock, restored);
		}
		return baselineMarkdown;
	}
	if (
		change.after &&
		change.currentBlock &&
		currentMarkdown.includes(change.currentBlock)
	) {
		const revertedBlock = change.currentBlock.replace(
			change.after,
			change.before,
		);
		return currentMarkdown.replace(change.currentBlock, revertedBlock);
	}
	return baselineMarkdown;
}

type EditSpan = { start: number; end: number };

/** Saved edits are Markdown source: drop emphasis markers and resolve
 * escapes (`\\[1]` shows as `[1]`) to compare with visible paragraph text. */
const MARKDOWN_ESCAPE_OR_MARK = /\\([!-/:-@[-`{-~])|[*_`~]/g;
const visibleText = (text?: string | null) =>
	(text ?? "")
		.replace(MARKDOWN_ESCAPE_OR_MARK, (_, escaped?: string) => escaped ?? "")
		.replace(/\s*\n+\s*/g, " ");

/**
 * Where an edit's written text sits in the current paragraph, found by the
 * text itself plus the context saved with the edit. Zero-width for a pure
 * deletion. `null` when the edit cannot be placed in this paragraph without
 * guessing (missing, ambiguous, or since rewritten).
 */
function locateEditSpan(block: string, event: ReviewEvent): EditSpan | null {
	const after = visibleText(event.after).trim();
	const prefix = visibleText(event.prefix).slice(-24).trimStart();
	const suffix = visibleText(event.suffix).slice(0, 24).trimEnd();
	const fits = (start: number, end: number) =>
		(!prefix || block.slice(0, start).trimEnd().endsWith(prefix.trimEnd())) &&
		(!suffix || block.slice(end).trimStart().startsWith(suffix.trimStart()));
	const candidates: EditSpan[] = [];
	if (after) {
		for (
			let at = block.indexOf(after);
			at >= 0;
			at = block.indexOf(after, at + 1)
		) {
			candidates.push({ start: at, end: at + after.length });
		}
	} else if (prefix) {
		for (
			let at = block.indexOf(prefix);
			at >= 0;
			at = block.indexOf(prefix, at + 1)
		) {
			const point = at + prefix.length;
			candidates.push({ start: point, end: point });
		}
	}
	let hit: EditSpan | null = null;
	if (prefix || suffix) {
		// Both saved sides must still surround it; otherwise it is not placed.
		const hits = candidates.filter((c) => fits(c.start, c.end));
		hit = hits.length === 1 ? hits[0] : null;
	} else if (after.length >= 12 && candidates.length === 1) {
		// No usable context: only a long, unique rewrite identifies itself.
		hit = candidates[0];
	}
	return hit && toWordEdges(block, hit);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Saved edits trim characters shared with the old text ("model|s"); the
 * word diff works on whole words, so widen the span to word edges. */
function toWordEdges(block: string, span: EditSpan): EditSpan {
	let { start, end } = span;
	while (
		start > 0 &&
		WORD_CHAR.test(block[start - 1]) &&
		WORD_CHAR.test(block[start] ?? "")
	)
		start--;
	while (
		end < block.length &&
		WORD_CHAR.test(block[end]) &&
		WORD_CHAR.test(block[end - 1] ?? "")
	)
		end++;
	return { start, end };
}

function eventCovers(
	event: ReviewEvent,
	change: TrackedChange,
	cache: Map<string, EditSpan | null>,
): boolean {
	if (change.blockDeletion) {
		const removed = visibleText(event.before);
		return change.blockDeletion.blocks.every((block) =>
			removed.includes(block.replace(/[*_`~]/g, "")),
		);
	}
	if (!change.baselineBlock || change.id.startsWith("chg-rep-")) {
		// A whole paragraph the edit wrote.
		const written = change.after.replace(/[*_`~]/g, "");
		if (change.after.length >= 8 && visibleText(event.after).includes(written))
			return true;
		// Or a paragraph mostly rewritten by it: the edit saved only the part
		// that changed, which must still sit in the paragraph and fill most of it.
		if (!change.id.startsWith("chg-rep-")) return false;
		const span = locateEditSpan(change.after, event);
		return Boolean(span && (span.end - span.start) * 2 >= change.after.length);
	}
	const key = `${event.id}\u0000${change.currentBlock}`;
	let span = cache.get(key);
	if (span === undefined) {
		span = locateEditSpan(change.currentBlock, event);
		cache.set(key, span);
	}
	if (!span) return false;
	// Word diffs attach neighbouring spaces to an op; compare its words only.
	const core = change.after.trim();
	const start =
		change.charOffset + change.after.length - change.after.trimStart().length;
	const end = start + core.length;
	return core
		? start >= span.start && end <= span.end
		: start >= span.start && start <= span.end;
}

/** A saved edit that rewrote several paragraphs, as one edit per paragraph:
 * changes are placed within one paragraph, which a multi-paragraph text never
 * fits. The first part keeps the context before the edit, the last the
 * context after it; whole paragraphs between identify themselves. */
function perParagraph(event: ReviewEvent): ReviewEvent[] {
	const parts = (event.after ?? "").split(/\n[ \t]*\n/);
	if (parts.length < 2) return [event];
	return parts.map((after, i) => ({
		...event,
		id: `${event.id}#${i}`,
		after: i === 0 ? after : stripMarkdownBlockPrefix(after),
		prefix: i === 0 ? event.prefix : "",
		suffix: i === parts.length - 1 ? event.suffix : "",
	}));
}

/**
 * Mark changes written by AI. Only unambiguous, still-present changes count:
 * if the author later rewrote an Agent edit, it is no longer Agent text.
 */
function attributeChanges(
	changes: TrackedChange[],
	events: readonly ReviewEvent[],
): void {
	const key = (before: string, after: string) =>
		`${before.length}:${before}${after}`;
	const counts = new Map<string, number>();
	for (const change of changes) {
		const k = key(change.before, change.after);
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const edits = events
		.filter(
			(event) =>
				event.kind === "edit" && event.before != null && event.after != null,
		)
		.flatMap(perParagraph);
	const deletionCount = changes.filter(
		(change) => change.kind === "delete",
	).length;
	const spanCache = new Map<string, EditSpan | null>();
	for (const change of changes) {
		const k = key(change.before, change.after);
		// The baseline may already contain an author's earlier rewrite. Match
		// the surviving Agent text too, rather than requiring equal "before" text.
		// Stored local context disambiguates identical edits elsewhere in the manuscript.
		const singleDeletion = change.kind === "delete" && deletionCount === 1;
		let lastWriter: ReviewEvent | undefined;
		for (let i = edits.length - 1; i >= 0; i--) {
			const event = edits[i];
			// An edit that wrote this region of the paragraph owns every diff
			// op inside it, however the word diff split its rewrite.
			if (eventCovers(event, change, spanCache)) {
				lastWriter = event;
				break;
			}
			// Removed paragraphs are matched by their text only.
			if (change.blockDeletion) continue;
			// Markdown emphasis markers at the edge of a block are absent from
			// Plate's visible leaf text, but remain in the saved edit context.
			const prefix = event.prefix && visibleText(event.prefix);
			const suffix = event.suffix && visibleText(event.suffix);
			const hasContext = Boolean(prefix || suffix);
			if (!hasContext && counts.get(k) !== 1) continue;
			// A deletion inside a punctuation token can appear in the paragraph
			// diff as a replacement: "，。" -> "。" rather than "，" -> "".
			const removedInsideToken =
				Boolean(event.before) &&
				event.after === "" &&
				change.before.replace(event.before ?? "", "") === change.after;
			if (hasContext) {
				const beforeText = change.currentBlock.slice(0, change.charOffset);
				const afterText = change.currentBlock.slice(
					change.charOffset + change.after.length,
				);
				if (
					(prefix && !beforeText.endsWith(prefix)) ||
					(suffix &&
						!(
							removedInsideToken ? change.after + afterText : afterText
						).startsWith(suffix))
				)
					continue;
			}
			if (
				key(event.before ?? "", event.after ?? "") === k ||
				removedInsideToken ||
				(hasContext &&
					change.after.length > 0 &&
					visibleText(event.after).includes(change.after)) ||
				(singleDeletion &&
					event.after === "" &&
					Boolean(event.before?.trim()) &&
					change.before.includes(visibleText(event.before).trim()))
			) {
				lastWriter = event;
				break;
			}
		}
		if (lastWriter?.actor === "agent") {
			change.actor = "agent";
			if (lastWriter.agent) change.agentName = lastWriter.agent;
		}
	}
}

function toChangeDecorations(
	editor: SlateEditor,
	changes: readonly TrackedChange[],
	changeRangeMap: ReadonlyMap<string, TRange>,
): ReviewAnchorRange[] {
	const changeDecorations: ReviewAnchorRange[] = [];
	for (const chg of changes) {
		const r = changeRangeMap.get(chg.id);
		if (!r) continue;
		const base: ReviewAnchorRange = {
			...r,
			reviewAnchor: true,
			anchorId: chg.id,
			reviewChangeKind: chg.kind,
			reviewChangeActor: chg.actor,
			...(chg.agentName ? { reviewChangeAgent: chg.agentName } : {}),
		};
		changeDecorations.push(base);
		if (chg.kind === "insert" || !chg.before) continue;
		// Removed text rides on a one-character carrier inside the change, so
		// it renders once even when the change spans several text nodes.
		const after = Boolean(
			chg.deletedAfter || chg.blockDeletion?.position === "after",
		);
		const carrier = after
			? {
					anchor: editor.api.before(r.focus, { unit: "character" }),
					focus: r.focus,
				}
			: {
					anchor: r.anchor,
					focus: editor.api.after(r.anchor, { unit: "character" }),
				};
		if (!carrier.anchor || !carrier.focus) continue;
		changeDecorations.push({
			...base,
			anchor: carrier.anchor,
			focus: carrier.focus,
			reviewDeletedText: chg.before,
			...(after ? { reviewDeletedAfter: true } : {}),
			...(chg.blockDeletion ? { reviewDeletedBlock: true } : {}),
		});
	}

	return changeDecorations;
}

const byPosition = (a: ReviewAnchorRange, b: ReviewAnchorRange) => {
	const cmp = comparePaths(a.anchor.path, b.anchor.path);
	return cmp !== 0 ? cmp : a.anchor.offset - b.anchor.offset;
};

/**
 * Decorations for one paragraph that changed since the last full pass (the
 * one being typed in), computed inside Slate's own render so the text under
 * the caret is split only once per keystroke. Mirrors the full pass for that
 * paragraph: tracked changes against its aligned baseline text, AI credit,
 * and comments whose quote it still contains.
 */
export function liveParagraphDecorations(
	editor: SlateEditor,
	node: TElement,
	path: Path,
	block: Omit<AlignedBlock, "path">,
	comments: readonly ReviewComment[],
	events: readonly ReviewEvent[],
): ReviewAnchorRange[] {
	const text = NodeApi.string(node);
	const match = BLOCK_ID_TAIL.exec(text);
	const leaf: LeafBlock = {
		path,
		text,
		stripped: match ? text.slice(0, match.index).trimEnd() : text,
		id: match ? match[1] : null,
	};
	const changes: TrackedChange[] = [];
	const ranges = new Map<string, TRange>();
	if (leaf.stripped.trim()) {
		for (const [change, range] of paragraphChanges(
			editor,
			leaf,
			block.liveIndex,
			block.base,
			-1,
		)) {
			if (!range) continue;
			changes.push(change);
			ranges.set(change.id, range);
		}
	}
	attributeChanges(changes, events);
	const out = toChangeDecorations(editor, changes, ranges);
	for (const comment of comments) {
		if (comment.status === "deleted" || comment.source === "pdf") continue;
		const at = comment.quote.trim() ? leaf.stripped.indexOf(comment.quote) : -1;
		if (at < 0 || leaf.stripped.indexOf(comment.quote, at + 1) >= 0) continue;
		const range = toRange(editor, leaf, at, comment.quote.length);
		if (range) {
			out.push({
				...range,
				anchorId: comment.id,
				anchorStatus: "attached",
				reviewAnchor: true,
			});
		}
	}
	return out.sort(byPosition);
}

/** Ids of the changes these edit events wrote (for jumping to new AI edits). */
export function changesWrittenBy(
	changes: readonly TrackedChange[],
	events: readonly ReviewEvent[],
): string[] {
	const spans = new Map<string, EditSpan | null>();
	return changes
		.filter((change) => events.some((e) => eventCovers(e, change, spans)))
		.map((change) => change.id);
}

type CacheEntry = {
	children: unknown;
	comments: readonly ReviewComment[];
	events: readonly ReviewEvent[];
	baselineText: string;
	ranges: ReviewAnchorRange[];
	changes: TrackedChange[];
	aligned: AlignedBlock[];
};

const cache = new WeakMap<SlateEditor, CacheEntry>();

export function computeReviewDecorations(
	editor: SlateEditor,
	comments: readonly ReviewComment[],
	baselineText: string,
	events: readonly ReviewEvent[] = [],
): {
	ranges: ReviewAnchorRange[];
	changes: TrackedChange[];
	aligned: AlignedBlock[];
} {
	const hit = cache.get(editor);
	if (
		hit &&
		hit.children === editor.children &&
		hit.comments === comments &&
		hit.events === events &&
		hit.baselineText === baselineText
	) {
		return { ranges: hit.ranges, changes: hit.changes, aligned: hit.aligned };
	}

	const commentRanges = computeCommentRanges(editor, comments, null);

	const {
		changes,
		ranges: changeRangeMap,
		aligned,
	} = computeTrackedChanges(editor, baselineText);
	attributeChanges(changes, events);
	const changeDecorations = toChangeDecorations(
		editor,
		changes,
		changeRangeMap,
	);

	const allRanges = [...commentRanges, ...changeDecorations].sort(byPosition);

	cache.set(editor, {
		children: editor.children,
		comments,
		events,
		baselineText,
		ranges: allRanges,
		changes,
		aligned,
	});
	return { ranges: allRanges, changes, aligned };
}

export function computeAnchorRanges(
	editor: SlateEditor,
	comments: readonly ReviewComment[],
	activeId: string | null,
): ReviewAnchorRange[] {
	return computeCommentRanges(editor, comments, activeId);
}

function computeCommentRanges(
	editor: SlateEditor,
	comments: readonly ReviewComment[],
	activeId: string | null,
): ReviewAnchorRange[] {
	const blocks = collectBlocks(editor);
	const ranges: ReviewAnchorRange[] = [];
	for (const comment of comments) {
		if (comment.status === "deleted" || comment.source === "pdf") continue;
		if (comment.anchor === "deleted" || comment.anchor === "unlocated") {
			continue;
		}
		const quote = comment.quote;
		if (!quote.trim()) continue;

		let block: LeafBlock | undefined;
		let index = -1;
		if (comment.blockId) {
			const target = blocks.find((b) => b.id === comment.blockId);
			if (target) {
				const i = target.stripped.indexOf(quote);
				if (i >= 0) {
					block = target;
					index = i;
				}
			}
		}
		if (!block) {
			const containing = blocks.filter((b) => b.stripped.includes(quote));
			const pick =
				containing.length === 1
					? containing[0]
					: disambiguateByContext(blocks, comment);
			if (pick) {
				block = pick;
				index = pick.stripped.indexOf(quote);
			}
		}
		if (!block || index < 0) continue;
		const range = toRange(editor, block, index, quote.length);
		if (!range) continue;
		ranges.push({
			...range,
			active: comment.id === activeId,
			anchorId: comment.id,
			anchorStatus: "attached",
			reviewAnchor: true,
		});
	}
	return ranges;
}

function comparePaths(a: Path, b: Path): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

function disambiguateByContext(
	blocks: LeafBlock[],
	comment: ReviewComment,
): LeafBlock | undefined {
	let best: LeafBlock | undefined;
	let bestScore = 0;
	let tied = false;
	for (const b of blocks) {
		let pos = 0;
		while (pos <= b.stripped.length) {
			const idx = b.stripped.indexOf(comment.quote, pos);
			if (idx < 0) break;
			const before = b.stripped.slice(0, idx);
			const after = b.stripped.slice(idx + comment.quote.length);
			const score =
				commonSuffix(before, comment.prefix ?? "") +
				commonPrefix(after, comment.suffix ?? "");
			if (score > bestScore) {
				bestScore = score;
				best = b;
				tied = false;
			} else if (score === bestScore && bestScore > 0 && best !== b) {
				tied = true;
			}
			pos = idx + Math.max(1, comment.quote.length);
		}
	}
	return bestScore > 0 && !tied ? best : undefined;
}

function commonSuffix(a: string, b: string): number {
	const aa = [...a];
	const bb = [...b];
	let n = 0;
	while (
		n < aa.length &&
		n < bb.length &&
		aa[aa.length - 1 - n] === bb[bb.length - 1 - n]
	) {
		n++;
	}
	return n;
}

function commonPrefix(a: string, b: string): number {
	const aa = [...a];
	const bb = [...b];
	let n = 0;
	while (n < aa.length && n < bb.length && aa[n] === bb[n]) n++;
	return n;
}

function toRange(
	editor: SlateEditor,
	block: LeafBlock,
	charStart: number,
	charLen: number,
): TRange | null {
	const start = editor.api.start(block.path);
	if (!start) return null;
	const anchor =
		charStart === 0
			? start
			: editor.api.after(start, { distance: charStart, unit: "character" });
	if (!anchor) return null;
	const focus = editor.api.after(anchor, {
		distance: charLen,
		unit: "character",
	});
	if (!focus) return null;
	return { anchor, focus };
}
