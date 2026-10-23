/**
 * Markdown for a long document without serializing all of it on every save.
 *
 * Serializing a 79k-character manuscript took 200–300 ms in the app, and the
 * autosave did it twice per pause in typing. The document is serialized in
 * segments instead, each cached against the node objects it came from: Slate
 * keeps an untouched top-level node the same object, so a save re-serializes
 * only the segments that changed. Joined, the segments are byte-for-byte the
 * whole-document output (checked against every Markdown file in the repo and
 * a real vault).
 *
 * A segment is one top-level block, or a run of list / indented blocks, whose
 * Markdown depends on their neighbours (tight lists, continuation paragraphs).
 */

import { MarkdownPlugin } from "@platejs/markdown";
import type { SlateEditor, TNode } from "platejs";

type Segment = { nodes: readonly TNode[]; markdown: string };

/** List items and indented continuation blocks join their neighbours. */
function joinsNeighbours(node: TNode): boolean {
	return Boolean(node.listStyleType) || Boolean(node.indent);
}

function segmentsOf(children: readonly TNode[]): TNode[][] {
	const segments: TNode[][] = [];
	for (const node of children) {
		const last = segments.at(-1);
		const previous = last?.at(-1);
		if (
			last &&
			previous &&
			joinsNeighbours(node) &&
			joinsNeighbours(previous)
		) {
			last.push(node);
		} else {
			segments.push([node]);
		}
	}
	return segments;
}

function sameNodes(a: readonly TNode[], b: readonly TNode[]): boolean {
	return a.length === b.length && a.every((node, i) => node === b[i]);
}

export type IncrementalSerializer = {
	/** The document's Markdown, re-serializing only changed segments. */
	serialize: () => string;
	/**
	 * Fill the cache in short slices between other work, so the first save
	 * after opening or reloading a long document is incremental too. Returns
	 * a function that stops it.
	 */
	warm: () => () => void;
};

/** Main-thread time one warm-up slice may take before yielding. */
const WARM_SLICE_MS = 8;

/** A serializer for `editor` that reuses unchanged segments between calls. */
export function createIncrementalSerializer(
	editor: SlateEditor,
): IncrementalSerializer {
	let cache = new Map<TNode, Segment>();
	const cached = (nodes: readonly TNode[]) => {
		const hit = cache.get(nodes[0]);
		return hit && sameNodes(hit.nodes, nodes) ? hit : undefined;
	};
	const serializeSegment = (nodes: readonly TNode[]) =>
		editor.getApi(MarkdownPlugin).markdown.serialize({ value: nodes as never });

	const serialize = () => {
		const segments = segmentsOf(editor.children);
		const next = new Map<TNode, Segment>();
		const parts = segments.map((nodes) => {
			const markdown = cached(nodes)?.markdown ?? serializeSegment(nodes);
			next.set(nodes[0], { nodes, markdown });
			return markdown;
		});
		cache = next;
		// Each segment ends with the stringifier's own newline; segments are
		// separated by one blank line, as in the whole-document output.
		return parts
			.map((text, i) => (i < parts.length - 1 ? text.replace(/\n$/, "") : text))
			.join("\n\n");
	};

	const warm = () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let index = 0;
		const slice = () => {
			// Re-read the document each slice: edits in between only cost the
			// segments they touched.
			const segments = segmentsOf(editor.children);
			const deadline = performance.now() + WARM_SLICE_MS;
			while (index < segments.length && performance.now() < deadline) {
				const nodes = segments[index++];
				if (!cached(nodes)) {
					cache.set(nodes[0], { nodes, markdown: serializeSegment(nodes) });
				}
			}
			if (index < segments.length) timer = setTimeout(slice, 0);
		};
		timer = setTimeout(slice, 0);
		return () => clearTimeout(timer);
	};

	return { serialize, warm };
}
