"use client";

/**
 * Keeps what the reader sees still while editor chunks above it change height.
 *
 * An off-screen chunk keeps the height it last had on screen (or an estimate),
 * and gets its real height only when it is drawn again, for example when the
 * reader scrolls back up after a zoom or after jumping down the document.
 * Browsers with scroll anchoring (`overflow-anchor`) absorb that; WebKit
 * before Safari 27 does not, so the text under the reader would jump. Here the
 * scroll position is moved by the change of every chunk entirely above the
 * viewport, before the frame is painted.
 */

import { type RefObject, useEffect } from "react";

const CHUNK = "[data-slate-chunk]";

export function useChunkScrollAnchor(
	scrollerRef: RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller || typeof ResizeObserver === "undefined") return;
		const heights = new WeakMap<Element, number>();
		const resizes = new ResizeObserver((entries) => {
			const top = scroller.getBoundingClientRect().top;
			const changes = entries.flatMap((entry) => {
				const height =
					entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
				const before = heights.get(entry.target);
				heights.set(entry.target, height);
				if (before === undefined || before === height) return [];
				return [
					{ box: entry.target.getBoundingClientRect(), delta: height - before },
				];
			});
			// Whether a chunk was above the viewport is decided by where its
			// bottom was before this round of changes: after a jump, the chunk
			// just above the target is drawn and grows into the viewport.
			changes.sort((a, b) => a.box.top - b.box.top);
			let moved = 0;
			let shift = 0;
			for (const { box, delta } of changes) {
				if (box.bottom - moved - delta <= top) shift += delta;
				moved += delta;
			}
			if (shift) scroller.scrollTop += shift;
		});
		// Lowest chunks are the editor root's own children; they come and go
		// as blocks are added, removed or reloaded.
		const root = scroller.querySelector("[data-slate-editor]") ?? scroller;
		for (const chunk of root.querySelectorAll(`:scope > ${CHUNK}`)) {
			resizes.observe(chunk);
		}
		const mutations = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node instanceof Element && node.matches(CHUNK)) {
						resizes.observe(node);
					}
				}
				for (const node of record.removedNodes) {
					if (node instanceof Element) resizes.unobserve(node);
				}
			}
		});
		mutations.observe(root, { childList: true });
		return () => {
			resizes.disconnect();
			mutations.disconnect();
		};
	}, [scrollerRef]);
}
