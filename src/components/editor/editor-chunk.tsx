"use client";

/**
 * A run of the editor's top-level blocks that the browser may skip laying out
 * and painting while it is off screen (`content-visibility: auto`, see
 * `.edda-editor-chunk`). Plate chunks every document, but by 1000 blocks: one
 * chunk for any real document, always on screen, so nothing was skipped and
 * every zoom, resize or long scroll laid out and painted the whole text.
 */

import type { PlateContentProps } from "platejs/react";

type ChunkProps = Parameters<NonNullable<PlateContentProps["renderChunk"]>>[0];

/** Top-level blocks per chunk: small enough to skip most of a long text,
 * large enough that the browser tracks a few dozen chunks, not hundreds. */
export const EDITOR_CHUNK_SIZE = 8;

export function EditorChunk({ attributes, children, lowest }: ChunkProps) {
	if (!lowest) return children;
	return (
		<div {...attributes} className="edda-editor-chunk">
			{children}
		</div>
	);
}
