/**
 * Bring the editor to a new value with as few changes as possible.
 *
 * An external write (an Agent editing the file, a sync, another app) used to
 * replace every node: every block re-rendered, comment ranges tracked in the
 * editor were lost, and the per-block caches (Markdown serialization, review
 * marks) started over, although such a write usually changes a few
 * paragraphs. Here top-level blocks are matched by content (CoCalc's
 * slate-diff idea: one token per block, then a sequence diff); unchanged
 * blocks keep their objects, and only the others are removed and inserted.
 *
 * A changed block is replaced whole, not edited in place, so comment ranges
 * in it reset and are placed again from the quotes the Agent's write updated
 * (`follow_rewrite` widens a quote to the rewritten words, which a range
 * moved through the edit would not).
 */

import type { Descendant, SlateEditor } from "platejs";
import { NodeApi } from "platejs";

/** A node without its `id`, in the form Slate's own normalization leaves
 * it (after an edit in the block): adjacent texts with the same marks
 * merged, empty texts (padding around inline elements) dropped. */
function canonical(node: Descendant): unknown {
	const {
		id: _,
		children,
		...rest
	} = node as Descendant & {
		id?: unknown;
		children?: Descendant[];
	};
	if (!children) return rest;
	const merged: Record<string, unknown>[] = [];
	for (const child of children.map(canonical) as Record<string, unknown>[]) {
		if (child.text === "") continue;
		const last = merged.at(-1);
		if (
			typeof child.text === "string" &&
			typeof last?.text === "string" &&
			JSON.stringify({ ...last, text: "" }) ===
				JSON.stringify({ ...child, text: "" })
		) {
			merged[merged.length - 1] = { ...last, text: last.text + child.text };
		} else {
			merged.push(child);
		}
	}
	return { ...rest, children: merged };
}

/** A block's content, ignoring `id` and Slate's normalization. */
function signature(node: Descendant): string {
	return JSON.stringify(canonical(node));
}

/**
 * The signature of the parsed block each node came from. Plugins normalize
 * inserted blocks and their neighbours further (a table wraps cell text in
 * paragraphs, a list renumbers `listStart`), so a node no longer looks like
 * the next parse of the same text; Slate never mutates a node, so the entry
 * holds until the block is edited.
 */
const parsedAs = new WeakMap<Descendant, string>();

/** Longest common subsequence of two token lists, as matched index pairs. */
function matchTokens(
	a: readonly string[],
	b: readonly string[],
): [number, number][] {
	// A rewrite of thousands of blocks at once: replace them rather than
	// build a table of every pair.
	if (a.length * b.length > 4_000_000) return [];
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table = new Uint32Array(rows * cols);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * cols + j] =
				a[i] === b[j]
					? table[(i + 1) * cols + j + 1] + 1
					: Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
		}
	}
	const pairs: [number, number][] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			pairs.push([i++, j++]);
		} else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
}

/**
 * Change `editor.children` into `next`. Returns the number of top-level blocks
 * that were inserted, removed or replaced.
 */
export function applyValueDiff(
	editor: SlateEditor,
	next: readonly Descendant[],
): number {
	// The empty paragraph kept after a final table or list (TrailingBlockPlugin)
	// is not in the file; leave it while the new value also ends that way, or
	// every write would remove it and normalization add it back.
	const last = editor.children.at(-1);
	const keepLast =
		last?.type === "p" &&
		editor.api.isEmpty(last as never) &&
		next.length > 0 &&
		next[next.length - 1].type !== "p";
	const current = keepLast ? editor.children.slice(0, -1) : editor.children;
	const before = current.map((node) => parsedAs.get(node) ?? signature(node));
	const after = next.map(signature);
	// Most writes touch a few blocks: match the shared start and end
	// directly and diff only what lies between.
	let head = 0;
	while (
		head < before.length &&
		head < after.length &&
		before[head] === after[head]
	) {
		head++;
	}
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	) {
		tail++;
	}
	const pairs: [number, number][] = [];
	for (let i = 0; i < head; i++) pairs.push([i, i]);
	for (const [i, j] of matchTokens(
		before.slice(head, before.length - tail),
		after.slice(head, after.length - tail),
	)) {
		pairs.push([head + i, head + j]);
	}
	for (let t = tail; t > 0; t--) {
		pairs.push([before.length - t, after.length - t]);
	}
	pairs.push([before.length, after.length]);
	let touched = 0;
	editor.tf.withoutNormalizing(() => {
		// Walk the gaps between matched blocks from the end, so earlier
		// indices stay valid while later ones change.
		for (let p = pairs.length - 1; p >= 0; p--) {
			const [oldEnd, newEnd] = pairs[p];
			const [oldStart, newStart] =
				p > 0 ? [pairs[p - 1][0] + 1, pairs[p - 1][1] + 1] : [0, 0];
			const removed = oldEnd - oldStart;
			const added = newEnd - newStart;
			if (!removed && !added) continue;
			touched += Math.max(removed, added);
			for (let k = removed - 1; k >= 0; k--) {
				editor.tf.removeNodes({ at: [oldStart + k] });
			}
			if (added) {
				editor.tf.insertNodes(next.slice(newStart, newEnd) as never, {
					at: [oldStart],
				});
			}
		}
	});
	// Normalized now. Remember what each block was parsed from, where
	// normalization left it in place (same type and text at its index).
	next.forEach((parsed, j) => {
		const node = editor.children[j];
		if (
			node?.type === parsed.type &&
			NodeApi.string(node) === NodeApi.string(parsed)
		) {
			parsedAs.set(node, after[j]);
		}
	});
	return touched;
}
