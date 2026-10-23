"use client";

import { ElementApi, NodeApi } from "platejs";
import {
	createPlatePlugin,
	PlateLeaf,
	type PlateLeafProps,
} from "platejs/react";
import i18n from "@/i18n";
import { cn } from "@/lib/core/utils";
import type { TrackedChangeKind } from "@/lib/review/anchor";
import { liveParagraphDecorations } from "@/lib/review/anchor";
import {
	decorationPathKey,
	presentRanges,
	type ReviewDecorationSnapshot,
	siblingCount,
} from "@/lib/review/decoration-index";

export const REVIEW_ANCHOR_KEY = "reviewAnchor";

/**
 * Word-style inline review leaf:
 * - Comment anchors render with warm editorial highlight + bottom border.
 * - Tracked insertions render with underline; deleted text renders struck
 *   through at its old position (whole paragraphs as their own lines).
 */
function ReviewAnchorLeaf(props: PlateLeafProps) {
	const leaf = props.leaf as unknown as {
		anchorId?: string;
		anchorStatus?: "attached" | "modified";
		reviewChangeKind?: TrackedChangeKind;
		reviewDeletedText?: string;
		reviewDeletedAfter?: boolean;
		reviewDeletedBlock?: boolean;
		reviewChangeVisible?: boolean;
		reviewChangeActor?: "agent";
		reviewChangeAgent?: string;
	};
	const isChange = Boolean(leaf.reviewChangeKind);

	if (isChange) {
		if (leaf.reviewChangeVisible === false) {
			return (
				<PlateLeaf
					{...props}
					as="span"
					attributes={{
						...props.attributes,
						"data-review-anchor-id": leaf.anchorId,
					}}
				>
					{props.children}
				</PlateLeaf>
			);
		}
		const isPureDelete = leaf.reviewChangeKind === "delete";
		const isAgent = leaf.reviewChangeActor === "agent";
		// Removed text stays where it was: before the next character, after the
		// last one, or as its own struck-through paragraph(s).
		const deleted = leaf.reviewDeletedText ? (
			<del
				contentEditable={false}
				className={cn(
					"review-change-delete select-none rounded-[2px]",
					leaf.reviewDeletedBlock
						? "my-1 block whitespace-pre-line px-1 py-0.5 font-normal leading-normal [font-size:var(--editor-font-size,1rem)]"
						: "mr-0.5",
				)}
			>
				{leaf.reviewDeletedText}
			</del>
		) : null;
		return (
			<PlateLeaf
				{...props}
				as="span"
				attributes={{
					...props.attributes,
					"data-review-anchor-id": leaf.anchorId,
					"data-review-change": leaf.reviewChangeKind,
					"data-review-actor": isAgent ? "agent" : "author",
					// Color encodes insertion/deletion; identity stays in the tooltip
					// and margin card, so an Agent's deletion is never colored green.
					title: isAgent
						? leaf.reviewChangeAgent
							? i18n.t("review:toolbar.agentChangeBy", {
									name: leaf.reviewChangeAgent,
								})
							: i18n.t("review:toolbar.agentChange")
						: i18n.t("review:toolbar.authorChange"),
				}}
				className={cn(
					"review-change cursor-pointer rounded-[2px] transition-colors",
				)}
			>
				{leaf.reviewDeletedAfter ? null : deleted}
				{isPureDelete ? (
					props.children
				) : (
					<ins className="review-change-insert">{props.children}</ins>
				)}
				{leaf.reviewDeletedAfter ? deleted : null}
			</PlateLeaf>
		);
	}

	return (
		<PlateLeaf
			{...props}
			as="mark"
			attributes={{
				...props.attributes,
				"data-review-anchor-id": leaf.anchorId,
			}}
			className={cn(
				"cursor-pointer rounded-[2px] border-review-comment/40 border-b bg-review-comment/10 text-inherit transition-colors",
				"data-[review-active=true]:bg-review-comment/20 data-[review-active=true]:ring-1 data-[review-active=true]:ring-ring",
			)}
		>
			{props.children}
		</PlateLeaf>
	);
}

/**
 * Review anchor + inline Track Changes decorations.
 */
export const ReviewAnchorPlugin = createPlatePlugin({
	// The bridge updates these after edits settle; decoration must never run a
	// whole-document diff synchronously inside Plate's render path.
	// Each bucket remembers the node it was computed for: an unchanged
	// paragraph keeps its marks. A paragraph edited since the snapshot (the
	// one being typed in) is decorated here, inside Slate's own render, so
	// the text under the caret is never re-split by a second pass.
	decorate: ({ editor, entry: [node, path], getOptions }) => {
		const snapshot = getOptions().snapshot;
		if (!snapshot) return [];
		const key = decorationPathKey(path);
		const ranges = snapshot.byPath.get(key) ?? [];
		const owner = path.length === 0 ? editor.children : node;
		const block = snapshot.blocks.get(key);
		if ((snapshot.nodes.get(key) ?? block?.node) === owner) return ranges;
		if (
			!block ||
			!ElementApi.isElement(node) ||
			editor.children.length !== snapshot.topCount ||
			siblingCount(
				editor,
				path.length > 1 ? NodeApi.get(editor, path.slice(0, -1)) : null,
			) !== block.siblings
		)
			return [];
		const live = liveParagraphDecorations(
			editor,
			node,
			path,
			block,
			snapshot.comments,
			snapshot.events,
		);
		return presentRanges(live, snapshot.view);
	},
	key: REVIEW_ANCHOR_KEY,
	node: { component: ReviewAnchorLeaf, isLeaf: true },
	options: {
		snapshot: null as ReviewDecorationSnapshot | null,
	},
});
