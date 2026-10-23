/** Session-only translation cards. Only explicit conversion writes a note. */
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FloatingCardFrame } from "@/components/viewer/pdf/cards/use-floating-card";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import {
	attachAgentRun,
	cancelAgentRun,
	disposeAgentRun,
	listAgents,
	runOnce,
} from "@/lib/agent";
import type { AgentRunRefs } from "@/lib/agent/run-attach";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import { createTranslateRecord } from "@/lib/pdf/translate";
import {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import { sameTranslateSelection } from "@/lib/pdf/translate/selection";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import { loadSettings } from "@/lib/settings";
import {
	buildTranslatePrompt,
	displayTranslateError,
	prepareTranslateTask,
	resolveTranslateAgent,
	runTranslate,
} from "@/lib/translate";
import { translateServiceKey } from "@/lib/translate/cache-key";

/** Pinned frame relative to the card's source anchor, in screen px. */
export type TranslationCardOffset = {
	dx: number;
	dy: number;
	width: number;
	height: number;
};

export type PdfTranslationCard = {
	record: PdfTranslateRecord;
	pages: FormattedSelection[];
	/** Source anchor on screen; recomputed as the PDF scrolls or zooms. */
	screen: CardScreenPoint;
	/** False while the source page is not mounted (virtualized far away). */
	anchored: boolean;
	/**
	 * Opened above the source because there was no room below. Fixed for the
	 * card's lifetime so it does not jump sides while the page scrolls.
	 */
	openUp: boolean;
	pinned: boolean;
	/** Where the user placed a pinned card, relative to `screen`. */
	offset: TranslationCardOffset | null;
	visible: boolean;
	streaming: boolean;
	converting: boolean;
};

/** Viewport frame of a pinned card: its source anchor plus the stored offset. */
export function translationCardFrame(
	card: Pick<PdfTranslationCard, "screen" | "offset">,
): FloatingCardFrame | null {
	if (!card.offset) return null;
	return {
		left: card.screen.x + card.offset.dx,
		top: card.screen.y + card.offset.dy,
		width: card.offset.width,
		height: card.offset.height,
	};
}

export type UsePdfSelectionTranslateOptions = {
	paperAbsPath: string | null;
	paperRelPath: string | null;
	vaultPath: string | null;
	getScreen: (anchor: PdfAskAnchor) => CardScreenPoint | null;
	onOpen: () => void;
	onConvertToNote: (
		pages: FormattedSelection[],
		quote: string,
		result: string,
	) => Promise<void>;
};

type TranslateRun = AgentRunRefs & { cacheKey: string };

/** Room a new card needs below its source before it opens upward instead. */
const OPEN_DOWN_ROOM_PX = 220;

function opensUp(screen: CardScreenPoint): boolean {
	const height = typeof window === "undefined" ? 800 : window.innerHeight;
	return (
		screen.y + OPEN_DOWN_ROOM_PX > height - 12 && screen.y > OPEN_DOWN_ROOM_PX
	);
}

export function usePdfSelectionTranslate({
	paperAbsPath,
	paperRelPath,
	vaultPath,
	getScreen,
	onOpen,
	onConvertToNote,
}: UsePdfSelectionTranslateOptions) {
	const { t } = useTranslation("viewer");
	const [cards, setCards] = useState<PdfTranslationCard[]>([]);
	const cardsRef = useRef(cards);
	const runs = useRef(new Map<string, TranslateRun>());
	const disposed = useRef(false);
	const replaceCards = useCallback((next: PdfTranslationCard[]) => {
		const cachedIds = new Set(
			next
				.filter((card) => !card.visible)
				.slice(-32)
				.map((card) => card.record.id),
		);
		const bounded = next.filter(
			(card) => card.visible || cachedIds.has(card.record.id),
		);
		cardsRef.current = bounded;
		setCards(bounded);
	}, []);
	const updateCard = useCallback(
		(id: string, update: (card: PdfTranslationCard) => PdfTranslationCard) => {
			replaceCards(
				cardsRef.current.map((card) =>
					card.record.id === id ? update(card) : card,
				),
			);
		},
		[replaceCards],
	);
	const stopRun = useCallback((id: string) => {
		const run = runs.current.get(id);
		runs.current.delete(id);
		if (run) disposeAgentRun(run);
	}, []);
	useEffect(() => {
		disposed.current = false;
		return () => {
			disposed.current = true;
			for (const run of runs.current.values()) disposeAgentRun(run);
			runs.current.clear();
		};
	}, []);

	const closeCard = useCallback(
		(id: string) => {
			const card = cardsRef.current.find((item) => item.record.id === id);
			if (card?.converting) return;
			stopRun(id);
			updateCard(id, (item) => ({
				...item,
				visible: false,
				pinned: false,
				streaming: false,
			}));
		},
		[stopRun, updateCard],
	);
	const dismissUnpinned = useCallback(() => {
		for (const card of cardsRef.current) {
			if (!card.pinned && card.visible) closeCard(card.record.id);
		}
	}, [closeCard]);
	const pinCard = useCallback(
		(id: string, pinned: boolean) => {
			if (!pinned) {
				for (const card of cardsRef.current) {
					if (card.record.id !== id && !card.pinned && card.visible)
						closeCard(card.record.id);
				}
			}
			updateCard(id, (card) => ({
				...card,
				pinned,
				// Unpinning snaps the card back beside its source.
				offset: pinned ? card.offset : null,
			}));
		},
		[closeCard, updateCard],
	);
	/** A pinned card was dragged / resized: keep it relative to its source. */
	const moveCard = useCallback(
		(id: string, frame: FloatingCardFrame) => {
			updateCard(id, (card) => ({
				...card,
				offset: {
					dx: frame.left - card.screen.x,
					dy: frame.top - card.screen.y,
					width: frame.width,
					height: frame.height,
				},
			}));
		},
		[updateCard],
	);
	/** Re-anchor every open card (pinned ones too) after the PDF moved. */
	const rePlaceCards = useCallback(() => {
		let changed = false;
		const next = cardsRef.current.map((card) => {
			if (!card.visible) return card;
			const screen = getScreen({ ...card.record, trigger: "selection" });
			if (!screen) {
				if (!card.anchored) return card;
				changed = true;
				return { ...card, anchored: false };
			}
			if (
				card.anchored &&
				screen.x === card.screen.x &&
				screen.y === card.screen.y
			)
				return card;
			changed = true;
			return { ...card, screen, anchored: true };
		});
		if (changed) replaceCards(next);
	}, [getScreen, replaceCards]);

	const convertToNote = useCallback(
		async (id: string) => {
			const card = cardsRef.current.find((item) => item.record.id === id);
			if (
				!card ||
				card.streaming ||
				card.converting ||
				card.record.error ||
				!card.record.result?.trim() ||
				!paperAbsPath
			)
				return;
			updateCard(id, (item) => ({ ...item, converting: true }));
			try {
				await onConvertToNote(
					card.pages,
					card.record.quote ?? "",
					card.record.result,
				);
				if (disposed.current) return;
				// Remove the temporary card only after the note has actually been saved.
				replaceCards(cardsRef.current.filter((item) => item.record.id !== id));
			} catch (error) {
				if (!disposed.current)
					updateCard(id, (item) => ({ ...item, converting: false }));
				notifyError(errorText(error));
			}
		},
		[paperAbsPath, onConvertToNote, replaceCards, updateCard],
	);

	const translateSelection = useCallback(
		(anchor: PdfAskAnchor, pages: FormattedSelection[]) => {
			const quote = anchor.quote?.trim();
			const screen = getScreen(anchor);
			if (!quote || !screen) return;
			const { task, providerId, targetLangName } = prepareTranslateTask({
				text: quote,
				context: { page: anchor.page, surface: "pdf-selection" },
			});
			const settings = loadSettings().translate;
			const cacheKey = JSON.stringify([
				translateServiceKey(settings),
				task.sourceLang,
				task.targetLang,
			]);
			const existing = cardsRef.current.find((card) =>
				sameTranslateSelection(card.record, anchor),
			);
			for (const card of cardsRef.current) {
				if (
					card.record.id !== existing?.record.id &&
					!card.pinned &&
					card.visible
				)
					closeCard(card.record.id);
			}
			onOpen();
			if (existing?.converting) return;
			if (
				existing &&
				(runs.current.get(existing.record.id)?.cacheKey === cacheKey ||
					(existing.record.cacheKey === cacheKey &&
						existing.record.result &&
						!existing.record.error))
			) {
				updateCard(existing.record.id, (card) => ({
					...card,
					visible: true,
					screen,
					anchored: true,
					openUp: card.visible ? card.openUp : opensUp(screen),
				}));
				return;
			}
			const rec = createTranslateRecord({
				paperPath: paperRelPath || paperAbsPath || "paper",
				page: anchor.page,
				rects: anchor.rects,
				quote,
				id: existing?.record.id,
			});
			stopRun(rec.id);
			const run: TranslateRun = {
				cacheKey,
				activeSessionRef: { current: null },
				disposedRef: { current: false },
				sessionRef: { current: null },
				unsubsRef: { current: null },
			};
			runs.current.set(rec.id, run);
			replaceCards([
				...cardsRef.current.filter((card) => card.record.id !== rec.id),
				{
					record: rec,
					pages,
					screen,
					anchored: true,
					openUp: opensUp(screen),
					pinned: existing?.pinned ?? false,
					offset: existing?.offset ?? null,
					visible: true,
					streaming: true,
					converting: false,
				},
			]);
			const isCurrent = () =>
				!disposed.current &&
				runs.current.get(rec.id) === run &&
				!run.disposedRef.current;
			const settle = () => {
				if (!isCurrent()) return;
				runs.current.delete(rec.id);
				updateCard(rec.id, (card) => ({ ...card, streaming: false }));
			};
			const fail = (error: unknown) => {
				if (!isCurrent()) return;
				const message = displayTranslateError(errorText(error));
				notifyError(message);
				updateCard(rec.id, (card) => ({
					...card,
					record: { ...card.record, error: message },
				}));
				settle();
			};
			const complete = (result: string, cancelled = false) => {
				if (!isCurrent()) return;
				updateCard(rec.id, (card) => ({
					...card,
					record: {
						...card.record,
						result: result.trim(),
						error: undefined,
						cacheKey: cancelled ? undefined : cacheKey,
					},
				}));
			};
			if (providerId !== "agent") {
				void runTranslate(task, { providerId })
					.then((result) => {
						complete(result);
						settle();
					})
					.catch(fail);
				return;
			}
			const paperKey = paperRelPath || paperAbsPath;
			void (async () => {
				try {
					const registry = await listAgents().catch(() => null);
					if (!isCurrent()) return;
					const { agentId, modelId } = resolveTranslateAgent(
						settings,
						registry,
					);
					if (!agentId) {
						fail(t("selection.translateNoAgent"));
						return;
					}
					const accepted = await runOnce({
						prompt: buildTranslatePrompt({
							text: quote,
							targetLangName,
							page: anchor.page,
							surface: "pdf-selection",
						}),
						agentId,
						modelId,
						vaultPath: vaultPath ?? undefined,
						// Concurrent fixed cards need independent provider sessions.
						sessionId:
							runs.current.size === 1
								? (getAgentTranslateSessionId(paperKey, agentId, modelId) ??
									undefined)
								: undefined,
						workflow: "translate",
						permissionMode: "auto",
						hideFromChatHistory: true,
					});
					if (!isCurrent()) {
						void cancelAgentRun(accepted.sessionId).catch(() => undefined);
						return;
					}
					await attachAgentRun({
						...run,
						accepted,
						onStream: (ev) => {
							if (!isCurrent()) return;
							updateCard(rec.id, (card) => ({
								...card,
								record: {
									...card.record,
									result: (card.record.result ?? "") + ev.chunk,
								},
							}));
						},
						onCompleted: (ev) => {
							if (!isCurrent()) return;
							const latest =
								cardsRef.current.find((card) => card.record.id === rec.id)
									?.record.result ?? "";
							complete(ev.content || latest, ev.stopReason === "cancelled");
							if (ev.providerSessionId && ev.stopReason !== "cancelled")
								setAgentTranslateSessionId(
									paperKey,
									agentId,
									modelId,
									ev.providerSessionId,
								);
						},
						onFailed: (ev) => {
							if (!isCurrent()) return;
							evictAgentTranslateSessionId(paperKey, agentId, modelId);
							fail(ev.error || t("pdfAsk.agentFailed"));
						},
						onSettled: settle,
					});
				} catch (error) {
					if (!isCurrent()) return;
					fail(error);
					disposeAgentRun(run);
				}
			})();
		},
		[
			getScreen,
			paperAbsPath,
			paperRelPath,
			vaultPath,
			closeCard,
			onOpen,
			replaceCards,
			stopRun,
			t,
			updateCard,
		],
	);

	return {
		cards,
		translateSelection,
		closeCard,
		pinCard,
		moveCard,
		convertToNote,
		dismissUnpinned,
		rePlaceCards,
	};
}
