"use client";

/**
 * Floating selection menu inside a review editor:
 * 1. "批注" — captures the selection quote + context (without mutating the
 *    document) and opens a Word-style margin balloon aligned to the selection.
 * 2. "引用" — opens the portable library citation picker (`[@citekey]` or
 *    author-year) and inserts the chosen citation after the selection.
 */

import { MessageSquarePlus, Quote } from "lucide-react";
import type { Path, SlateEditor, TElement } from "platejs";
import { ElementApi, NodeApi, RangeApi } from "platejs";
import { useEditorRef } from "platejs/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CitationPicker } from "@/components/review/citation-picker";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import { notifyWarning } from "@/lib/core/notify";
import { setCommentDraft } from "@/lib/review/store";

const CONTEXT_CHARS = 32;

function nearestHeading(editor: SlateEditor, blockPath: Path): string {
	const top = blockPath[0] ?? 0;
	for (let i = top; i >= 0; i--) {
		const node = editor.children[i] as TElement | undefined;
		if (!node || !ElementApi.isElement(node)) continue;
		const type = typeof node.type === "string" ? node.type : "";
		if (/^h[1-6]$/.test(type)) return NodeApi.string(node).trim();
	}
	return "";
}

/**
 * Capture the current editor selection as a comment draft (with `anchorY` for
 * margin balloon alignment). Returns true if a non-empty selection was captured.
 */
export function captureEditorSelectionDraft(
	editor: SlateEditor,
	reviewId: string,
	noSelectionMessage?: string,
): boolean {
	const sel = editor.selection;
	if (!sel || RangeApi.isCollapsed(sel)) {
		if (noSelectionMessage) notifyWarning(noSelectionMessage);
		return false;
	}
	const start = editor.api.block({ at: sel.anchor });
	if (!start) return false;
	const [blockNode, blockPath] = start;
	const blockText = NodeApi.string(blockNode);
	const quote = editor.api.string(sel).trim();
	if (!quote) return false;

	const at = blockText.indexOf(quote);
	const prefix =
		at >= 0 ? blockText.slice(Math.max(0, at - CONTEXT_CHARS), at) : "";
	const suffix =
		at >= 0
			? blockText.slice(at + quote.length, at + quote.length + CONTEXT_CHARS)
			: "";

	// Measure the editor's selection, not the window's: clicking the floating
	// selection menu clears the browser selection before this runs, while the
	// editor keeps its own, so the draft used to land at the top of the page.
	let anchorY = 24;
	const dom = editor.api.toDOMNode(editor);
	const scroller = dom?.closest(".edda-scroll") as HTMLElement | null;
	const range = editor.api.toDOMRange(sel);
	if (scroller && range) {
		const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
		const scrollerRect = scroller.getBoundingClientRect();
		if (rect.height > 0) {
			anchorY = Math.max(
				12,
				rect.top - scrollerRect.top + scroller.scrollTop - 8,
			);
		}
	}

	setCommentDraft(reviewId, {
		blockId: null,
		heading: nearestHeading(editor, blockPath),
		prefix,
		quote,
		suffix,
		anchorY,
	});
	return true;
}

type PendingPoint = {
	x: number;
	y: number;
};

export function ReviewSelectionMenu({
	reviewId,
	enabled = true,
	libraryCitations = true,
}: {
	reviewId: string;
	enabled?: boolean;
	libraryCitations?: boolean;
}) {
	const editor = useEditorRef();
	const { t } = useTranslation("review");
	const [pending, setPending] = useState<PendingPoint | null>(null);
	const [citation, setCitation] = useState<PendingPoint | null>(null);

	useEffect(() => {
		if (!enabled) {
			setPending(null);
			setCitation(null);
			return;
		}
		const dom = editor.api.toDOMNode(editor);
		const container = dom?.closest(".edda-scroll") as HTMLDivElement | null;
		if (!container) return;

		const onMouseUp = () => {
			window.setTimeout(() => {
				const sel = editor.selection;
				if (!sel || RangeApi.isCollapsed(sel)) {
					setPending(null);
					return;
				}
				const domSelection = window.getSelection();
				if (!domSelection || domSelection.rangeCount === 0) {
					setPending(null);
					return;
				}
				const rect = domSelection.getRangeAt(0).getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) {
					setPending(null);
					return;
				}
				setPending({ x: rect.left + rect.width / 2, y: rect.top });
			}, 0);
		};
		const onMouseDown = () => setPending(null);
		container.addEventListener("mouseup", onMouseUp);
		container.addEventListener("mousedown", onMouseDown);
		return () => {
			container.removeEventListener("mouseup", onMouseUp);
			container.removeEventListener("mousedown", onMouseDown);
		};
	}, [editor, enabled]);
	if (!enabled) return null;

	if (citation) {
		return (
			<CitationPicker
				onClose={() => setCitation(null)}
				onPick={(choice) => {
					const sel = editor.selection;
					if (sel && !RangeApi.isCollapsed(sel)) {
						const end = RangeApi.end(sel);
						editor.tf.insertText(` ${choice.token}`, { at: end });
						editor.tf.select(end);
					} else if (sel) {
						editor.tf.insertText(choice.token, { at: sel.anchor });
					}
					setCitation(null);
				}}
				point={citation}
			/>
		);
	}

	if (!pending) return null;

	const openCitationPicker = () => {
		setPending((current) => {
			if (current) setCitation(current);
			return null;
		});
	};

	const captureDraft = () => {
		setPending(null);
		captureEditorSelectionDraft(editor, reviewId);
	};

	return (
		<ViewportFloating
			className="z-50 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-floating"
			offset={6}
			point={pending}
			side="top"
		>
			<button
				aria-label={t("selection.comment")}
				className="flex h-7 items-center gap-1 rounded-sm px-2 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
				onClick={captureDraft}
				title={t("selection.comment")}
				type="button"
			>
				<MessageSquarePlus size={14} />
				<span>{t("toolbar.newComment")}</span>
			</button>
			{libraryCitations ? (
				<>
					<div className="h-4 w-px bg-border" />
					<button
						aria-label={t("selection.cite")}
						className="flex h-7 items-center gap-1 rounded-sm px-2 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
						onClick={openCitationPicker}
						title={t("selection.cite")}
						type="button"
					>
						<Quote size={13} />
						<span>{t("selection.cite")}</span>
					</button>
				</>
			) : null}
		</ViewportFloating>
	);
}
