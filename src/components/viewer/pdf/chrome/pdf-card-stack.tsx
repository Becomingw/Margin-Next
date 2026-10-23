import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { SelectionCopiedLabel } from "@/components/ui/selection-copied-label";
import {
	type CitationPreviewImportMenu,
	PdfCitationPreview,
} from "@/components/viewer/pdf/cards/citation-preview";
import { PdfCrossrefPreview } from "@/components/viewer/pdf/cards/crossref-preview";
import { LegacyAskCard } from "@/components/viewer/pdf/cards/legacy-ask-card";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import type { FloatingCardFrame } from "@/components/viewer/pdf/cards/use-floating-card";
import { VisualTraceCard } from "@/components/viewer/pdf/cards/visual-trace-card";
import {
	type PdfTranslationCard,
	translationCardFrame,
} from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import type {
	CardScreenPoint,
	CitationPreviewState,
	CrossrefPreviewState,
	SelectionMenuState,
} from "@/components/viewer/pdf/types";
import { cn } from "@/lib/core/utils";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace";
import type { PdfAskThread } from "@/lib/pdf/ask";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

type PdfCardStackProps = {
	selectionMenu: {
		state: SelectionMenuState | null;
		onHighlight: (color: HighlightColor) => void;
		onAddToChat: () => void;
		onTranslate: () => void;
		/**
		 * Capture the selection as a review comment (review-unit PDFs only).
		 * Omit to hide the action on ordinary paper tabs.
		 */
		onReviewComment?: () => void;
		/** Hide highlight / translate (no marks/ to persist into); keep Ask. */
		showHighlight?: boolean;
		showTranslate?: boolean;
	};
	/** Transient screen position for the auto-copy confirmation label. */
	copiedLabelPos: { x: number; y: number } | null;
	citationPreview: {
		state: CitationPreviewState | null;
		importMenu?: CitationPreviewImportMenu;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	crossrefPreview: {
		state: CrossrefPreviewState | null;
		onHoverEnter: () => void;
		onHoverLeave: () => void;
	};
	/** Shared anchor of the pin-attached cards (ask / translate). */
	cardScreen: CardScreenPoint | null;
	/** Shared hover-hide contract of the pin-attached cards. */
	onCardHoverEnter: () => void;
	onCardHoverLeave: () => void;
	ask: {
		thread: PdfAskThread | null;
		onQuote: () => void;
		onHide: () => void;
		onDelete: () => void;
	};
	translate: {
		record: PdfTranslateRecord | null;
		streaming: boolean;
		error: string | null;
		onOpenSettings: () => void;
		onHide: () => void;
		onDelete: () => void;
	};
	translations: {
		cards: PdfTranslationCard[];
		onClose: (id: string) => void;
		onPin: (id: string, pinned: boolean) => void;
		onMove: (id: string, frame: FloatingCardFrame) => void;
		onConvertToNote?: (id: string) => void;
		onOpenSettings: () => void;
		/** PDF reading area: cards scroll out of it instead of over app chrome. */
		clipRect: ViewportRect | null;
		/** Source text of a card on screen, for the hover link. */
		getSourceRects: (card: PdfTranslationCard) => ViewportRect[];
	};
	visual: {
		trace: PdfVisualSessionTrace | null;
		onHide: () => void;
		onDelete: () => void;
	};
	/** Privacy mode: fade the floating cards while the window is unfocused. */
	hidden?: boolean;
};

export type ViewportRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/** Straight leader from the source text's nearest point to the card's. */
export function sourceLeader(
	source: readonly ViewportRect[],
	card: ViewportRect,
): { x1: number; y1: number; x2: number; y2: number } | null {
	if (!source.length) return null;
	const left = Math.min(...source.map((r) => r.left));
	const top = Math.min(...source.map((r) => r.top));
	const right = Math.max(...source.map((r) => r.left + r.width));
	const bottom = Math.max(...source.map((r) => r.top + r.height));
	const clampTo = (v: number, lo: number, hi: number) =>
		Math.min(Math.max(v, lo), hi);
	const cardCx = card.left + card.width / 2;
	const cardCy = card.top + card.height / 2;
	const x1 = clampTo(cardCx, left, right);
	const y1 = clampTo(cardCy, top, bottom);
	const x2 = clampTo(x1, card.left, card.left + card.width);
	const y2 = clampTo(y1, card.top, card.top + card.height);
	// Overlapping (card sits on its source): nothing to point at.
	if (x1 === x2 && y1 === y2) return null;
	return { x1, y1, x2, y2 };
}

/**
 * Floating cards of the viewer, portaled to `document.body` so page transforms
 * and the scroller's overflow never clip or scale them. Translation cards sit
 * in a layer clipped to the reading area: they follow their source text like
 * annotations and scroll out with it.
 */
export function PdfCardStack({
	selectionMenu,
	copiedLabelPos,
	citationPreview,
	crossrefPreview,
	cardScreen,
	onCardHoverEnter,
	onCardHoverLeave,
	ask,
	translate,
	translations,
	visual,
	hidden = false,
}: PdfCardStackProps) {
	const [linkedCardId, setLinkedCardId] = useState<string | null>(null);
	if (typeof document === "undefined") return null;
	const linkedCard = linkedCardId
		? translations.cards.find(
				(card) => card.record.id === linkedCardId && card.visible,
			)
		: undefined;
	const linkedSource = linkedCard
		? translations.getSourceRects(linkedCard)
		: [];
	const linkedFrame = linkedCard ? translationCardFrame(linkedCard) : null;
	const leader =
		linkedFrame && linkedSource.length
			? sourceLeader(linkedSource, linkedFrame)
			: null;

	return createPortal(
		<div
			inert={hidden}
			aria-hidden={hidden || undefined}
			className={cn(
				"transition-opacity duration-150",
				hidden && "pointer-events-none opacity-0",
			)}
		>
			{selectionMenu.state ? (
				<SelectionMenu
					screen={selectionMenu.state.screen}
					onHighlight={selectionMenu.onHighlight}
					onAddToChat={selectionMenu.onAddToChat}
					onTranslate={selectionMenu.onTranslate}
					onReviewComment={selectionMenu.onReviewComment}
					showHighlight={selectionMenu.showHighlight}
					showTranslate={selectionMenu.showTranslate}
				/>
			) : null}

			{copiedLabelPos ? (
				<SelectionCopiedLabel x={copiedLabelPos.x} y={copiedLabelPos.y} />
			) : null}

			{citationPreview.state ? (
				<PdfCitationPreview
					screen={citationPreview.state.screen}
					matched={citationPreview.state.matched}
					importMenu={citationPreview.importMenu}
					onPointerEnter={citationPreview.onHoverEnter}
					onPointerLeave={citationPreview.onHoverLeave}
				/>
			) : null}

			{crossrefPreview.state ? (
				<PdfCrossrefPreview
					screen={crossrefPreview.state.screen}
					kind={crossrefPreview.state.kind}
					page={crossrefPreview.state.page}
					image={crossrefPreview.state.image}
					onPointerEnter={crossrefPreview.onHoverEnter}
					onPointerLeave={crossrefPreview.onHoverLeave}
				/>
			) : null}

			<AnimatePresence>
				{ask.thread && cardScreen ? (
					<LegacyAskCard
						onPointerEnter={onCardHoverEnter}
						onPointerLeave={onCardHoverLeave}
						key={`ask-${ask.thread.id}`}
						thread={ask.thread}
						screen={cardScreen}
						onQuote={ask.onQuote}
						onHide={ask.onHide}
						onDelete={ask.onDelete}
					/>
				) : null}
			</AnimatePresence>

			<AnimatePresence>
				{translate.record && cardScreen ? (
					<TranslateCard
						key={`translate-${translate.record.id}`}
						screen={cardScreen}
						preferRight={cardScreen.preferRight ?? false}
						result={translate.record.result ?? ""}
						streaming={translate.streaming}
						error={translate.error ?? translate.record.error ?? null}
						onOpenSettings={translate.onOpenSettings}
						onHide={translate.onHide}
						onDelete={translate.onDelete}
						onPointerEnter={onCardHoverEnter}
						onPointerLeave={onCardHoverLeave}
					/>
				) : null}
			</AnimatePresence>

			<div
				className="pointer-events-none fixed inset-0 z-50"
				style={
					translations.clipRect
						? { ...translations.clipRect, clipPath: "inset(0)" }
						: undefined
				}
			>
				{/* Hovered / dragged card: show which text it translates. */}
				{linkedSource.map((rect) => (
					<div
						key={`${rect.left}:${rect.top}`}
						aria-hidden
						className="fixed rounded-[2px] bg-primary/15 ring-1 ring-primary/50"
						style={rect}
					/>
				))}
				{leader ? (
					// biome-ignore lint/a11y/noSvgWithoutTitle: decorative leader line
					<svg
						aria-hidden
						className="fixed inset-0 h-screen w-screen overflow-visible"
					>
						<line
							{...leader}
							className="stroke-primary/60"
							strokeWidth={1.5}
							strokeDasharray="3 3"
						/>
					</svg>
				) : null}
				<AnimatePresence>
					{translations.cards
						.filter((card) => card.visible && card.anchored)
						.map((card) => (
							<TranslateCard
								key={card.record.id}
								anchored
								openUp={card.openUp}
								bounds={translations.clipRect}
								screen={card.screen}
								preferRight={card.screen.preferRight ?? false}
								result={card.record.result ?? ""}
								streaming={card.streaming}
								error={card.record.error ?? null}
								pinned={card.pinned}
								converting={card.converting}
								frame={translationCardFrame(card)}
								onFrameChange={(frame) =>
									translations.onMove(card.record.id, frame)
								}
								onPinnedChange={(pinned) =>
									translations.onPin(card.record.id, pinned)
								}
								onPointerEnter={() => setLinkedCardId(card.record.id)}
								onPointerLeave={() =>
									setLinkedCardId((id) => (id === card.record.id ? null : id))
								}
								onHide={() => translations.onClose(card.record.id)}
								onDelete={() => translations.onClose(card.record.id)}
								onConvertToNote={
									translations.onConvertToNote
										? () => translations.onConvertToNote?.(card.record.id)
										: undefined
								}
								onOpenSettings={translations.onOpenSettings}
							/>
						))}
				</AnimatePresence>
			</div>

			<AnimatePresence>
				{visual.trace && cardScreen ? (
					<VisualTraceCard
						key={`visual-${visual.trace.id}`}
						trace={visual.trace}
						screen={cardScreen}
						preferRight={cardScreen.preferRight ?? true}
						onHide={visual.onHide}
						onDelete={visual.onDelete}
						onPointerEnter={onCardHoverEnter}
						onPointerLeave={onCardHoverLeave}
					/>
				) : null}
			</AnimatePresence>
		</div>,
		document.body,
	);
}
