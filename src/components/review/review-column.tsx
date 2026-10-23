"use client";

/**
 * Office Word-style right-margin review balloons.
 *
 * When paired with the manuscript editor (`anchorPositions` provided), each
 * comment balloon is positioned vertically beside
 * its anchored paragraph (`top = max(anchorY, prevBottom + 10)`), translating
 * in lockstep with the document scroll container so comments float naturally
 * in the margin instead of sitting in a disconnected sidebar list.
 *
 * When paired with a standalone PDF viewer, renders a clean margin rail for
 * page-anchored PDF comments.
 */

import {
	ChevronDown,
	MessageSquarePlus,
	PanelRightClose,
	TextQuote,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ChangeCard } from "@/components/review/change-card";
import { CommentCard } from "@/components/review/comment-card";
import type { ReviewComment } from "@/lib/core/bindings";
import { cn } from "@/lib/core/utils";
import {
	addPdfComment,
	submitCommentDraft,
	updateComment,
} from "@/lib/review/actions";
import type { TrackedChange } from "@/lib/review/anchor";
import { layoutBalloons } from "@/lib/review/balloon-layout";
import type { ReviewDecorationView } from "@/lib/review/decoration-index";
import {
	patchReviewUi,
	reviewStore,
	setCommentDraft,
	setPdfCommentDraft,
} from "@/lib/review/store";

/** Anchor tops in the editor's scroll-content pixels, and the viewport top of
 * that scroll area (the editor toolbar sits above it, the column header above
 * the balloons). */
export type AnchorPositions = {
	byId: ReadonlyMap<string, number>;
	frameTop: number;
};

export type ReviewColumnProps = {
	vaultPath: string;
	reviewId: string;
	/** Document-order index per anchor id. */
	anchorOrder: Map<string, number>;
	/** Where each comment's quote sits beside the editor. */
	anchorPositions?: AnchorPositions;
	/** Translated directly on editor scroll to avoid re-rendering the manuscript. */
	scrollContainerRef?: React.Ref<HTMLDivElement>;
	onWheelForward?: (deltaY: number) => void;
	/** AI comments the user has not been shown yet. */
	newCommentIds?: readonly string[];
	/** Agent colors and an optional focus on one Agent's comment threads. */
	view?: Pick<ReviewDecorationView, "hues" | "focus">;
	/** Only the selected change is shown, alongside the existing comment balloons. */
	changes?: readonly TrackedChange[];
	changesDisabled?: boolean;
	onAcceptChange?: (change: TrackedChange) => void;
	onRejectChange?: (change: TrackedChange) => void;
	/** A short, independently scrollable rail below a narrow manuscript. */
	compact?: boolean;
	/** Keep comment/reply drafts mounted while the original preview is showing. */
	hidden?: boolean;
};

function DraftBalloon({
	vaultPath,
	reviewId,
}: {
	vaultPath: string;
	reviewId: string;
}) {
	const { t } = useTranslation("review");
	const draft = useStore(reviewStore, (s) => s.drafts[reviewId]);
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const hasDraft = Boolean(draft);
	useEffect(() => {
		if (hasDraft) composerRef.current?.focus({ preventScroll: true });
	}, [hasDraft]);
	if (!draft) return null;

	const submit = async () => {
		const text = body.trim();
		if (!text || busy) return;
		setBusy(true);
		const ok = await submitCommentDraft(vaultPath, reviewId, text);
		setBusy(false);
		if (ok) setBody("");
	};

	return (
		<div className="relative rounded-lg border border-ring bg-card p-4 text-sm">
			<div className="border-l-2 border-border pl-2 text-muted-foreground text-xs leading-relaxed">
				<span className="line-clamp-2">{draft.quote}</span>
			</div>
			<textarea
				ref={composerRef}
				className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void submit();
					}
					if (e.key === "Escape") {
						e.preventDefault();
						setCommentDraft(reviewId, null);
					}
				}}
				placeholder={t("composer.placeholder")}
				rows={3}
				value={body}
			/>
			<div className="mt-1.5 flex justify-end gap-1.5">
				<button
					className="h-6 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-accent"
					onClick={() => setCommentDraft(reviewId, null)}
					type="button"
				>
					{t("composer.cancel")}
				</button>
				<button
					className="h-6 rounded-md bg-primary px-2.5 text-primary-foreground text-xs transition-colors disabled:opacity-50"
					disabled={!body.trim() || busy}
					onClick={() => void submit()}
					type="button"
				>
					{t("composer.submit")}
				</button>
			</div>
		</div>
	);
}

function PdfComposer({
	vaultPath,
	reviewId,
}: {
	vaultPath: string;
	reviewId: string;
}) {
	const { t } = useTranslation("review");
	const draft = useStore(reviewStore, (s) => s.pdfDrafts[reviewId]);
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const hasDraft = Boolean(draft);
	useEffect(() => {
		if (hasDraft) composerRef.current?.focus();
	}, [hasDraft]);
	if (!draft) return null;

	const submit = async () => {
		const text = body.trim();
		if (!text || busy) return;
		setBusy(true);
		const ok = await addPdfComment(
			vaultPath,
			reviewId,
			draft.quote,
			draft.page,
			text,
		);
		setBusy(false);
		if (ok) {
			setBody("");
			setPdfCommentDraft(reviewId, null);
		}
	};

	return (
		<div className="rounded-lg border border-ring bg-card p-4 text-sm">
			<div className="text-[11px] text-muted-foreground">
				<span className="font-mono">{t("pdf.page", { page: draft.page })}</span>
			</div>
			<div className="mt-1 border-l-2 border-border pl-2 text-muted-foreground text-xs leading-relaxed">
				<span className="line-clamp-3">{draft.quote}</span>
			</div>
			<textarea
				className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
				onChange={(e) => setBody(e.target.value)}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void submit();
					}
					if (e.key === "Escape") {
						e.preventDefault();
						setPdfCommentDraft(reviewId, null);
					}
				}}
				placeholder={t("composer.placeholder")}
				ref={composerRef}
				rows={3}
				value={body}
			/>
			<div className="mt-1.5 flex justify-end gap-1.5">
				<button
					className="h-6 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-accent"
					onClick={() => setPdfCommentDraft(reviewId, null)}
					type="button"
				>
					{t("composer.cancel")}
				</button>
				<button
					className="h-6 rounded-md bg-primary px-2.5 text-primary-foreground text-xs transition-colors disabled:opacity-50"
					disabled={!body.trim() || busy}
					onClick={() => void submit()}
					type="button"
				>
					{t("composer.submit")}
				</button>
			</div>
		</div>
	);
}

type BalloonItem =
	| { id: string; kind: "draft"; anchorY: number }
	| { id: string; kind: "change"; change: TrackedChange; anchorY: number }
	| { id: string; kind: "comment"; comment: ReviewComment; anchorY: number };

export function ReviewColumn({
	vaultPath,
	reviewId,
	anchorOrder,
	anchorPositions,
	scrollContainerRef,
	onWheelForward,
	newCommentIds = [],
	view,
	changes = [],
	changesDisabled = false,
	onAcceptChange,
	onRejectChange,
	compact = false,
	hidden = false,
}: ReviewColumnProps) {
	const { t } = useTranslation("review");
	const doc = useStore(reviewStore, (s) => s.docs[reviewId]);
	const ui = useStore(reviewStore, (s) => s.ui[reviewId]);
	const draft = useStore(reviewStore, (s) => s.drafts[reviewId]);
	const pdfDraft = useStore(reviewStore, (s) => s.pdfDrafts[reviewId]);
	const activeCommentId = useStore(reviewStore, (s) => s.activeCommentId);
	const selectedCommentId = useStore(reviewStore, (s) => s.selectedCommentId);
	const selectedChange = changes.find(
		(change) => change.id === selectedCommentId,
	);
	const filter = ui?.filter ?? "all";
	const [unplacedOpen, setUnplacedOpen] = useState(false);
	// Distance from the balloon layer's top to the editor scroll area's top.
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const [frameOffset, setFrameOffset] = useState(0);
	const frameTop = anchorPositions?.frameTop;
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!body || frameTop === undefined) return;
		const next = frameTop - body.getBoundingClientRect().top;
		setFrameOffset((prev) => (prev === next ? prev : next));
	}, [frameTop]);
	const newIds = useMemo(() => new Set(newCommentIds), [newCommentIds]);

	// Card heights, kept current by one observer: a card that opens or gets a
	// reply moves its neighbours. Ref callbacks are cached per card so a
	// re-render does not detach and re-measure every card.
	const [heights, setHeights] = useState<Record<string, number>>({});
	const [observer] = useState(() =>
		typeof ResizeObserver === "undefined"
			? null
			: new ResizeObserver((entries) => {
					setHeights((prev) => {
						let next = prev;
						for (const entry of entries) {
							const id = (entry.target as HTMLElement).dataset.balloonId;
							const h = (entry.target as HTMLElement).offsetHeight;
							if (!id || prev[id] === h) continue;
							if (next === prev) next = { ...prev };
							next[id] = h;
						}
						return next;
					});
				}),
	);
	useEffect(() => () => observer?.disconnect(), [observer]);
	const measureRefs = useRef(
		new Map<string, (el: HTMLDivElement | null) => void>(),
	);
	const measureNode = useCallback(
		(id: string) => {
			let ref = measureRefs.current.get(id);
			if (!ref) {
				let node: HTMLDivElement | null = null;
				ref = (el) => {
					if (node) observer?.unobserve(node);
					node = el;
					if (el) observer?.observe(el);
				};
				measureRefs.current.set(id, ref);
			}
			return ref;
		},
		[observer],
	);

	const focus = view?.focus ?? null;
	const visibleComments = useMemo(() => {
		const all = (doc?.comments ?? []).filter(
			(c) => !focus || focus.commentIds.has(c.id),
		);
		return filter === "open"
			? all.filter((c) => c.status === "open" && c.anchor !== "deleted")
			: all.filter((c) => c.status !== "deleted");
	}, [doc, filter, focus]);

	const handleCommentAction = useCallback(
		(
			commentId: string,
			action: "reply" | "edit" | "resolve" | "reopen" | "delete" | "restore",
			body?: string,
			expectedUpdatedAt?: string,
			replyId?: string,
		) =>
			updateComment(
				vaultPath,
				reviewId,
				commentId,
				action,
				body,
				expectedUpdatedAt,
				replyId,
			),
		[vaultPath, reviewId],
	);

	const hasPositionedMargin = Boolean(anchorPositions);

	// Comments without a place in the text (PDF page comments, quotes that
	// were removed or cannot be located) are listed apart instead of being
	// stacked at made-up heights beside unrelated paragraphs.
	const unplaced = useMemo(
		() =>
			hasPositionedMargin
				? visibleComments.filter((c) => !anchorOrder.has(c.id))
				: [],
		[hasPositionedMargin, visibleComments, anchorOrder],
	);

	const balloonItems = useMemo<BalloonItem[]>(() => {
		const list: BalloonItem[] = [];
		if (draft) {
			list.push({
				id: "__draft__",
				kind: "draft",
				anchorY: draft.anchorY ?? 24,
			});
		}
		for (const c of visibleComments) {
			const y = anchorPositions?.byId.get(c.id);
			// Anchored but not measured yet (first frame): skip rather than guess.
			if (y === undefined) continue;
			list.push({ id: c.id, kind: "comment", comment: c, anchorY: y });
		}
		if (
			selectedChange &&
			(!focus || selectedChange.agentName === focus.agent)
		) {
			const y = anchorPositions?.byId.get(selectedChange.id);
			if (y !== undefined)
				list.push({
					id: selectedChange.id,
					kind: "change",
					change: selectedChange,
					anchorY: y,
				});
		}
		list.sort((a, b) => a.anchorY - b.anchorY);
		return list;
	}, [draft, visibleComments, anchorPositions, selectedChange, focus]);

	const placedBalloons = useMemo(() => {
		const tops = layoutBalloons(
			balloonItems,
			heights,
			draft ? "__draft__" : selectedCommentId,
			frameOffset,
		);
		return balloonItems.map((item, i) => ({ ...item, top: tops[i] }));
	}, [balloonItems, heights, frameOffset, draft, selectedCommentId]);
	const selectedPlaced = placedBalloons.some(
		(item) => item.id === selectedCommentId,
	);
	// Reveal only on selection / layout-mode changes, never fight manual rail scrolling.
	useLayoutEffect(() => {
		if (!compact || !selectedCommentId || !selectedPlaced || hidden) return;
		bodyRef.current
			?.querySelector<HTMLElement>(
				`[data-balloon-id="${CSS.escape(selectedCommentId)}"]`,
			)
			?.scrollIntoView({ block: "nearest" });
	}, [compact, selectedCommentId, selectedPlaced, hidden]);

	if (!doc) return null;
	const renderChange = (change: TrackedChange) =>
		onAcceptChange && onRejectChange ? (
			<ChangeCard
				change={change}
				hue={change.agentName ? view?.hues.get(change.agentName) : undefined}
				disabled={changesDisabled}
				onAccept={onAcceptChange}
				onReject={onRejectChange}
			/>
		) : null;

	const header = (
		<div className="relative flex h-11 shrink-0 items-center gap-1 border-hairline-soft border-b px-3 text-xs">
			<span className="mr-2 font-medium">{t("column.title")}</span>
			<button
				type="button"
				className="inline-flex h-6 items-center rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				onClick={() =>
					patchReviewUi(reviewId, {
						filter: filter === "open" ? "all" : "open",
					})
				}
				title={filter === "open" ? t("filter.all") : t("filter.open")}
			>
				{t(filter === "open" ? "column.filterOpen" : "column.filterAll")}
			</button>
			{unplaced.length ? (
				<button
					type="button"
					aria-expanded={unplacedOpen}
					className={cn(
						"inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground tabular-nums transition-colors hover:bg-accent hover:text-foreground",
						unplacedOpen && "bg-accent text-foreground",
					)}
					onClick={() => setUnplacedOpen((open) => !open)}
					title={t("column.unplacedHint")}
				>
					<TextQuote size={12} aria-hidden />
					{t("column.unplaced", { count: unplaced.length })}
					<ChevronDown
						size={12}
						aria-hidden
						className={cn("transition-transform", unplacedOpen && "rotate-180")}
					/>
				</button>
			) : null}
			<div className="flex-1" />
			<button
				type="button"
				aria-label={t("column.hide")}
				title={t("column.hide")}
				className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				onClick={() => patchReviewUi(reviewId, { commentsVisible: false })}
			>
				<PanelRightClose size={13} />
			</button>
			{unplacedOpen && unplaced.length ? (
				<div className="edda-scroll absolute top-full right-2 left-2 z-20 mt-1 max-h-[60vh] space-y-2 overflow-y-auto rounded-lg border bg-popover p-2 shadow-floating">
					{unplaced.map((c) => (
						<CommentCard
							active={activeCommentId === c.id}
							selected={selectedCommentId === c.id}
							comment={c}
							hues={view?.hues}
							isNew={newIds.has(c.id)}
							key={c.id}
							onAction={handleCommentAction}
						/>
					))}
				</div>
			) : null}
		</div>
	);

	// Positioned Word-style margin balloons alongside the manuscript editor.
	if (hasPositionedMargin) {
		const isEmpty =
			placedBalloons.length === 0 && unplaced.length === 0 && !pdfDraft;
		return (
			<aside
				aria-label={t("column.comments")}
				data-compact={compact}
				className={cn(
					"review-rail relative flex h-full w-80 shrink-0 select-none flex-col border-hairline-soft border-l bg-background",
					hidden && "hidden",
				)}
				onWheel={(e) => {
					if (!compact && onWheelForward && e.deltaY !== 0) {
						onWheelForward(e.deltaY);
					}
				}}
			>
				{header}
				<div
					ref={bodyRef}
					className={cn(
						"relative min-h-0 flex-1",
						compact ? "edda-scroll overflow-y-auto" : "overflow-hidden",
					)}
				>
					{isEmpty ? (
						<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground text-xs">
							<MessageSquarePlus className="size-4 opacity-50" aria-hidden />
							<p>{t("empty.open")}</p>
						</div>
					) : (
						<div
							ref={compact ? undefined : scrollContainerRef}
							className={cn(
								"relative w-full px-3",
								compact && "space-y-3 py-3",
							)}
							style={compact ? { transform: "none" } : undefined}
						>
							{placedBalloons.map((item) => (
								<div
									key={item.id}
									ref={measureNode(item.id)}
									data-balloon-id={item.id}
									className={compact ? "relative" : "absolute right-3 left-3"}
									style={compact ? undefined : { top: item.top }}
								>
									{item.kind === "draft" ? (
										<DraftBalloon reviewId={reviewId} vaultPath={vaultPath} />
									) : item.kind === "change" ? (
										renderChange(item.change)
									) : (
										<CommentCard
											active={activeCommentId === item.id}
											selected={selectedCommentId === item.id}
											comment={item.comment}
											hues={view?.hues}
											isNew={newIds.has(item.id)}
											onAction={handleCommentAction}
										/>
									)}
								</div>
							))}
						</div>
					)}
				</div>
			</aside>
		);
	}

	// Standalone PDF review margin fallback.
	return (
		<aside
			aria-label={t("column.comments")}
			data-compact={compact}
			className={cn(
				"review-rail flex h-full w-80 shrink-0 flex-col border-hairline-soft border-l bg-background",
				hidden && "hidden",
			)}
		>
			{header}
			<div className="edda-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
				{selectedChange ? renderChange(selectedChange) : null}
				{draft ? (
					<DraftBalloon reviewId={reviewId} vaultPath={vaultPath} />
				) : null}
				<PdfComposer reviewId={reviewId} vaultPath={vaultPath} />
				{visibleComments.length === 0 &&
				!pdfDraft &&
				!draft &&
				!selectedChange ? (
					<div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground text-xs">
						<MessageSquarePlus className="size-4 opacity-50" aria-hidden />
						<p>{t("empty.open")}</p>
					</div>
				) : (
					visibleComments.map((c) => (
						<CommentCard
							active={activeCommentId === c.id}
							selected={selectedCommentId === c.id}
							comment={c}
							hues={view?.hues}
							isNew={newIds.has(c.id)}
							key={c.id}
							onAction={handleCommentAction}
						/>
					))
				)}
			</div>
		</aside>
	);
}
