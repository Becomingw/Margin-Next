/**
 * Selection actions (highlight / note / copy / ask / add-to-chat / translate).
 *
 * Highlight / quote-to-Agent / translate are wired to the
 * floating selection toolbar; note is typed on the right-rail selection
 * comment chip and committed from there.
 * Detection and menu state stay in {@link usePdfTextSelection}; each action's
 * real work belongs to its own cluster.
 */

import type {
	FormattedSelection,
	useSelectionCapability,
} from "@embedpdf/plugin-selection/react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
} from "react";
import type { SelectionMenuState } from "@/components/viewer/pdf/types";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { registerSelectionAgentAction } from "@/lib/agent/selection-agent-action";
import {
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import { openRightTab } from "@/lib/shell/ui-window-actions";

type SelectionCapabilityProvides = ReturnType<
	typeof useSelectionCapability
>["provides"];

export type UsePdfSelectionActionsOptions = {
	isActive: boolean;
	/** Placed menu; every action no-ops when null. */
	selectionMenu: SelectionMenuState | null;
	setSelectionMenu: Dispatch<SetStateAction<SelectionMenuState | null>>;
	closeSelectionMenu: () => void;
	/** Highlights cluster writer. */
	createHighlights: (
		pages: FormattedSelection[],
		color: HighlightColor,
		quote: string,
	) => { pageIndex: number; id: string }[];
	/** Write the note body onto a freshly created highlight. */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	selectionCap: SelectionCapabilityProvides;
	docId: string;
	/** Translate cluster entry (creates the record and starts the run). */
	translateSelection: (
		anchor: PdfAskAnchor,
		pages: FormattedSelection[],
	) => void;
	paperRelPath: string | null;
	paperAbsPath: string | null;
	/**
	 * Capture the selection as a review comment (PDF review workspaces).
	 * Receives the quote and its 1-based page.
	 */
	onReviewComment?: (selection: { quote: string; page: number }) => void;
};

export type PdfSelectionActions = {
	handleHighlight: (color: HighlightColor) => void;
	/**
	 * Create a highlight + comment from a snapped selection draft. Used by the
	 * right-rail chip so typing can survive EmbedPDF clearing the live selection.
	 */
	handleCommitSelectionNote: (
		draft: {
			pages: FormattedSelection[];
			quote: string;
		},
		comment: string,
	) => void;
	handleMenuAddToChat: () => void;
	handleMenuTranslate: () => void;
	/** Hand the live selection to the review column; no-op without a reviewer. */
	handleMenuReviewComment: () => void;
};

export function usePdfSelectionActions({
	isActive,
	selectionMenu,
	setSelectionMenu,
	closeSelectionMenu,
	createHighlights,
	updateHighlightComment,
	selectionCap,
	docId,
	translateSelection,
	paperRelPath,
	paperAbsPath,
	onReviewComment,
}: UsePdfSelectionActionsOptions): PdfSelectionActions {
	// The right-rail annotate chip lives inside the page DOM. EmbedPDF often
	// clears the live selection on pointerdown before React re-renders, so
	// action handlers read this snapshot instead of the possibly-null state.
	const selectionMenuRef = useRef(selectionMenu);
	selectionMenuRef.current = selectionMenu;

	const handleHighlight = useCallback(
		(color: HighlightColor) => {
			const menu = selectionMenuRef.current;
			if (!menu) return;
			createHighlights(menu.pages, color, menu.anchor.quote ?? "");
			closeSelectionMenu();
		},
		[createHighlights, closeSelectionMenu],
	);

	const handleCommitSelectionNote = useCallback(
		(
			draft: { pages: FormattedSelection[]; quote: string },
			comment: string,
		) => {
			const trimmed = comment.trim();
			if (!trimmed || !draft.pages.length) return;
			const created = createHighlights(
				draft.pages,
				DEFAULT_HIGHLIGHT_COLOR,
				draft.quote,
			);
			const first = created[0];
			setSelectionMenu(null);
			selectionCap?.clear(docId);
			if (!first) return;
			updateHighlightComment(first.pageIndex, first.id, trimmed);
		},
		[
			createHighlights,
			updateHighlightComment,
			selectionCap,
			docId,
			setSelectionMenu,
		],
	);

	const handleMenuAddToChat = useCallback(() => {
		const menu = selectionMenuRef.current;
		if (!menu) return;
		const anchor = menu.anchor;
		const quote = anchor.quote?.trim();
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		if (!quote) return;
		// Re-publish after clear: clearing the PDF selection also drops the live chip.
		// Preserve the complete reference snapshot for message attachments and navigation.
		publishSelection({
			...menu.reference,
			text: quote,
			sourcePath: paperRelPath ?? paperAbsPath ?? "PDF",
			origin: "pdf",
			page: anchor.page,
			rects: anchor.rects,
			paperAbsPath: paperAbsPath ?? undefined,
		});
		pinActiveSelection();
		openRightTab("agent");
		focusAgentComposer();
	}, [selectionCap, docId, paperRelPath, paperAbsPath, setSelectionMenu]);
	useEffect(
		() =>
			registerSelectionAgentAction(() => {
				if (!isActive || !selectionMenuRef.current) return false;
				handleMenuAddToChat();
				return true;
			}),
		[handleMenuAddToChat, isActive],
	);

	const handleMenuTranslate = useCallback(() => {
		const menu = selectionMenuRef.current;
		if (!menu) return;
		const anchor = menu.anchor;
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		translateSelection(anchor, menu.pages);
	}, [selectionCap, docId, setSelectionMenu, translateSelection]);

	// Review workspaces have no marks/ to write into, so the action only
	// captures quote + page and lets the review column own persistence.
	const handleMenuReviewComment = useCallback(() => {
		if (!onReviewComment) return;
		const menu = selectionMenuRef.current;
		if (!menu) return;
		const quote = menu.anchor.quote?.trim() ?? "";
		setSelectionMenu(null);
		selectionCap?.clear(docId);
		if (!quote) return;
		onReviewComment({ page: menu.anchor.page + 1, quote });
	}, [onReviewComment, selectionCap, docId, setSelectionMenu]);

	return {
		handleHighlight,
		handleCommitSelectionNote,
		handleMenuAddToChat,
		handleMenuTranslate,
		handleMenuReviewComment,
	};
}
