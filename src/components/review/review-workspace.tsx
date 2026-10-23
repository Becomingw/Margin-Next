"use client";

/**
 * Review Workspace: always-tracked revisions, comments and PDF comparison.
 * The toolbar contains view, navigation, accept/reject and export actions.
 * - Manuscript surface + synchronized right-margin floating balloons.
 * - Dual-mode PDF + Manuscript review for imported PDF manuscripts.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
	Check,
	CheckCheck,
	ChevronDown,
	ChevronUp,
	Columns2,
	Download,
	FileCode2,
	FileText,
	Loader2,
	MessageSquare,
	MessageSquarePlus,
	Quote,
	RefreshCw,
	RotateCcw,
	Sparkles,
	X,
} from "lucide-react";
import { RangeApi, type TRange } from "platejs";
import { useEditorRef, useEditorSelector } from "platejs/react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { CitationPicker } from "@/components/review/citation-picker";
import {
	type AgentStat,
	ReviewAgentMenu,
} from "@/components/review/review-agent-menu";
import { ReviewAnchorPlugin } from "@/components/review/review-anchor-plugin";
import {
	type AnchorPositions,
	ReviewColumn,
} from "@/components/review/review-column";
import { ReviewConnector } from "@/components/review/review-connector";
import {
	captureEditorSelectionDraft,
	ReviewSelectionMenu,
} from "@/components/review/selection-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { DocViewEditorProps } from "@/components/workspace/doc-view-types";
import { useReviewStore } from "@/hooks/use-app-stores";
import type { CommentAnchor } from "@/lib/core/bindings";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { localFileToArrayBuffer } from "@/lib/paper";
import {
	applyTrackedChange,
	checkpointReview,
	exportReview,
	openReview,
	parseReviewPdf,
	recordEdit,
	saveReviewManuscript,
} from "@/lib/review/actions";
import { agentCommentIds, agentHues } from "@/lib/review/agents";
import {
	buildBaselineAfterAcceptSingle,
	changesWrittenBy,
	computeReviewDecorations,
	rejectTrackedChange,
	type TrackedChange,
} from "@/lib/review/anchor";
import {
	type CommentRefs,
	movedCommentAnchors,
	syncCommentRefs,
	withMovedAnchors,
} from "@/lib/review/comment-ranges";
import {
	buildReviewSnapshot,
	type ReviewDecorationView,
} from "@/lib/review/decoration-index";
import {
	markAgentItemsSeen,
	patchReviewUi,
	type ReviewViewMode,
	requestRevealAnchor,
	reviewStore,
	reviewUi,
	selectComment,
	setActiveComment,
	setCommentDraft,
	setPdfCommentDraft,
	unseenAgentItems,
} from "@/lib/review/store";
import { joinVaultPath } from "@/lib/vault";
import type { DocTab } from "@/lib/workspace/tabs";

const MarkdownEditor = lazy(() =>
	import("@/components/editor").then((m) => ({
		default: m.MarkdownEditor,
	})),
);

const PdfViewer = lazy(() =>
	import("@/components/viewer").then((m) => ({
		default: m.PdfViewer,
	})),
);

const REVIEW_PLUGINS = [ReviewAnchorPlugin];

function EditorSkeleton() {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-busy="true">
			<Skeleton className="library-shimmer h-4 w-2/5" />
			<Skeleton className="library-shimmer h-3 w-full" />
			<Skeleton className="library-shimmer h-3 w-11/12" />
		</div>
	);
}

type BridgeActions = {
	createCommentFromSelection: () => void;
	insertCitationToken: (token: string) => void;
	/** Comments whose text the author's edits moved, to save with them. */
	movedCommentAnchors: () => CommentAnchor[];
	rejectChange: (change: TrackedChange) => boolean;
	resolutionCandidate: (
		change: TrackedChange,
		current: string,
		action: "accept" | "reject",
	) => Promise<string | null>;
	scrollByDelta: (deltaY: number) => void;
};

const isChangeId = (id: string) => id.startsWith("chg-");

/** The browser has laid out and drawn this editor chunk's content (it is not
 * skipped by `content-visibility: auto`). */
const isDrawn = (chunk: HTMLElement) =>
	chunk.firstElementChild?.checkVisibility?.({ contentVisibilityAuto: true }) ??
	true;

/** The id `delta` steps away from the active one, wrapping around. */
function stepThrough(
	ids: readonly string[],
	activeId: string | null,
	delta: number,
): string | undefined {
	if (!ids.length) return undefined;
	const index = activeId ? ids.indexOf(activeId) : -1;
	return ids[
		index < 0
			? delta < 0
				? ids.length - 1
				: 0
			: (index + delta + ids.length) % ids.length
	];
}

const navButton =
	"flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";

/** Count + previous/next for one kind of review item. */
function ReviewJumper({
	ids,
	count,
	icon,
	label,
	prevLabel,
	nextLabel,
	tone,
	onReveal,
}: {
	ids: readonly string[];
	count: number;
	icon: React.ReactNode;
	label: string;
	prevLabel: string;
	nextLabel: string;
	tone?: "brand";
	onReveal: (id: string) => void;
}) {
	const activeId = useStore(
		reviewStore,
		(s) => s.selectedCommentId ?? s.activeCommentId,
	);
	const step = (delta: number) => {
		const next = stepThrough(ids, activeId, delta);
		if (next) onReveal(next);
	};
	return (
		<div className="inline-flex shrink-0 items-center gap-0.5">
			<button
				type="button"
				disabled={!ids.length}
				title={label}
				aria-label={label}
				className={cn(
					"inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition-colors hover:bg-accent disabled:opacity-40",
					tone === "brand"
						? "text-brand"
						: "text-muted-foreground hover:text-foreground",
				)}
				onClick={() => step(1)}
			>
				{icon}
				{count}
			</button>
			<button
				type="button"
				disabled={!ids.length}
				title={prevLabel}
				aria-label={prevLabel}
				className={navButton}
				onClick={() => step(-1)}
			>
				<ChevronUp size={14} />
			</button>
			<button
				type="button"
				disabled={!ids.length}
				title={nextLabel}
				aria-label={nextLabel}
				className={navButton}
				onClick={() => step(1)}
			>
				<ChevronDown size={14} />
			</button>
		</div>
	);
}

function ReviewChangeControls({
	trackedChanges,
	onAcceptChange,
	onRejectChange,
	onAcceptAll,
	onRejectAll,
	disabled,
	onReveal,
}: {
	trackedChanges: TrackedChange[];
	onAcceptChange: (change: TrackedChange) => void;
	onRejectChange: (change: TrackedChange) => void;
	onAcceptAll: () => void;
	onRejectAll: () => void;
	disabled: boolean;
	onReveal: (id: string) => void;
}) {
	const { t } = useTranslation("review");
	const activeId = useStore(
		reviewStore,
		(s) => s.selectedCommentId ?? s.activeCommentId,
	);
	const ids = useMemo(() => trackedChanges.map((c) => c.id), [trackedChanges]);
	const activeChange = trackedChanges.find((c) => c.id === activeId);
	const step = (delta: number) => {
		const next = stepThrough(ids, activeId, delta);
		if (next) onReveal(next);
	};
	return (
		<>
			<div className="inline-flex shrink-0 items-center gap-0.5">
				<button
					type="button"
					disabled={!ids.length}
					title={t("toolbar.prevItem")}
					aria-label={t("toolbar.prevItem")}
					className={navButton}
					onClick={() => step(-1)}
				>
					<ChevronUp size={14} />
				</button>
				<span
					className="min-w-12 text-center text-muted-foreground text-xs tabular-nums"
					title={t("changes.count", { count: ids.length })}
				>
					{activeChange ? ids.indexOf(activeChange.id) + 1 : "–"} / {ids.length}
				</span>
				<button
					type="button"
					disabled={!ids.length}
					title={t("toolbar.nextItem")}
					aria-label={t("toolbar.nextItem")}
					className={navButton}
					onClick={() => step(1)}
				>
					<ChevronDown size={14} />
				</button>
			</div>
			<div className="inline-flex shrink-0 items-center gap-0.5">
				<button
					type="button"
					disabled={disabled || !activeChange}
					title={t("toolbar.acceptChange")}
					aria-label={t("toolbar.acceptChange")}
					className="inline-flex h-7 w-7 items-center justify-center rounded-md text-review-insert transition-colors hover:bg-accent disabled:opacity-40"
					onClick={() => {
						if (activeChange) onAcceptChange(activeChange);
					}}
				>
					<Check size={13} />
				</button>
				<button
					type="button"
					disabled={disabled || !trackedChanges.length}
					title={t("toolbar.acceptAll")}
					aria-label={t("toolbar.acceptAll")}
					className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
					onClick={onAcceptAll}
				>
					<CheckCheck size={13} />
				</button>
				<button
					type="button"
					disabled={disabled || !activeChange}
					title={t("toolbar.rejectChange")}
					aria-label={t("toolbar.rejectChange")}
					className="inline-flex h-6 w-6 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-40"
					onClick={() => {
						if (activeChange) onRejectChange(activeChange);
					}}
				>
					<X size={13} />
				</button>
				<button
					type="button"
					disabled={disabled || !trackedChanges.length}
					title={t("toolbar.rejectAll")}
					aria-label={t("toolbar.rejectAll")}
					className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
					onClick={onRejectAll}
				>
					<RotateCcw size={12} />
				</button>
			</div>
		</>
	);
}

/** Colors per Agent, clean mode and Agent focus, shared by the decoration
 * snapshot, the comment column and the ribbon. */
function useReviewView(reviewId: string): ReviewDecorationView {
	const doc = useStore(reviewStore, (s) => s.docs[reviewId]);
	const changeDisplay = useStore(
		reviewStore,
		(s) => s.ui[reviewId]?.changeDisplay ?? "markup",
	);
	const agent = useStore(
		reviewStore,
		(s) => s.ui[reviewId]?.agentFocus ?? null,
	);
	const agents = doc?.agents;
	const comments = doc?.comments;
	// The Host lists the Agents of the whole history (the panel holds this
	// round's events only), so colours stay put from round to round.
	const hues = useMemo(() => agentHues(agents ?? []), [agents]);
	return useMemo(
		() => ({
			changesVisible: changeDisplay === "markup",
			hues,
			focus: agent
				? { agent, commentIds: agentCommentIds(comments ?? [], agent) }
				: null,
		}),
		[changeDisplay, hues, agent, comments],
	);
}

type BridgeProps = {
	reviewId: string;
	libraryCitations: boolean;
	onAnchorOrder: (order: Map<string, number>) => void;
	/** Anchor tops in scroll-content pixels, plus the scroller's viewport top
	 * so the margin can line its cards up with the text. */
	onAnchorPositions: (positions: AnchorPositions) => void;
	onTrackedChanges: (changes: TrackedChange[]) => void;
	onScrollTopChange: (scrollTop: number) => void;
	onLayout: () => void;
	actionsRef: React.MutableRefObject<BridgeActions | null>;
};

/** Recompute decorations within the edit's frame while it stays this cheap. */
const SYNC_DECORATION_BUDGET_MS = 8;
const SLOW_DECORATION_DELAY_MS = 150;
/** Pause in typing after which the full pass refreshes positions and ids. */
const TYPING_IDLE_MS = 400;

/** Same top-level structure with at most two blocks replaced: an edit inside
 * existing paragraphs, which the plugin decorates live. */
function isInParagraphEdit(
	previous: readonly unknown[] | null,
	next: readonly unknown[],
): boolean {
	if (!previous || previous.length !== next.length) return false;
	let changed = 0;
	for (let i = 0; i < next.length; i++) {
		if (previous[i] !== next[i] && ++changed > 2) return false;
	}
	return true;
}

/** Runs inside `<Plate>`: decoration snapshot, anchor measurement, scroll sync. */
function ReviewEditorBridge({
	reviewId,
	libraryCitations,
	onAnchorOrder,
	onAnchorPositions,
	onTrackedChanges,
	onScrollTopChange,
	onLayout,
	actionsRef,
}: BridgeProps) {
	const editor = useEditorRef();
	const children = useEditorSelector((e) => e.children, []);
	const { t } = useTranslation("review");
	const doc = useStore(reviewStore, (s) => s.docs[reviewId]);
	const commentsVisible = useStore(
		reviewStore,
		(s) => s.ui[reviewId]?.commentsVisible ?? true,
	);
	const selectionEnabled = useStore(
		reviewStore,
		(s) => s.ui[reviewId]?.changeDisplay !== "original",
	);
	const selectionEnabledRef = useRef(selectionEnabled);
	selectionEnabledRef.current = selectionEnabled;
	const activeCommentId = useStore(
		reviewStore,
		(s) => s.activeCommentId ?? s.selectedCommentId,
	);
	const selectedCommentId = useStore(reviewStore, (s) => s.selectedCommentId);
	const revealRequest = useStore(reviewStore, (s) => s.revealRequest);
	const comments = useMemo(() => doc?.comments ?? [], [doc]);
	const reviewEvents = useMemo(() => {
		if (!doc) return [];
		// A single-change accept updates this round's baseline in place. Keep
		// the other AI edits from the round, stopping only at its initial checkpoint.
		let boundary = -1;
		for (let i = 0; i < doc.events.length; i++) {
			const event = doc.events[i];
			if (event.kind === "checkpoint" && event.revisionId === doc.baselineId) {
				boundary = i;
				break;
			}
		}
		return doc.events.slice(boundary + 1);
	}, [doc]);
	const baselineText = doc?.baselineText ?? "";
	// Word-style comment ranges, moved by Slate through every edit.
	const commentRefsRef = useRef<CommentRefs>(new Map());
	const commentsRef = useRef(comments);
	commentsRef.current = comments;
	useEffect(() => {
		const refs = commentRefsRef.current;
		return () => {
			for (const ref of refs.values()) ref.unref();
			refs.clear();
		};
	}, []);

	// Expose imperative editor actions to the top review toolbar.
	useEffect(() => {
		actionsRef.current = {
			createCommentFromSelection: () => {
				captureEditorSelectionDraft(
					editor,
					reviewId,
					t("selection.singleBlock"),
				);
			},
			insertCitationToken: (token: string) => {
				const sel = editor.selection;
				if (sel && !RangeApi.isCollapsed(sel)) {
					const end = RangeApi.end(sel);
					editor.tf.insertText(` ${token}`, { at: end });
					editor.tf.select(end);
				} else if (sel) {
					editor.tf.insertText(token, { at: sel.anchor });
				} else {
					editor.tf.insertText(` ${token}`);
				}
			},
			movedCommentAnchors: () =>
				movedCommentAnchors(
					editor,
					commentsRef.current,
					commentRefsRef.current,
				),
			rejectChange: (change) =>
				rejectTrackedChange(editor, baselineText, change),
			resolutionCandidate: async (change, current, action) => {
				const { revisionCandidate } = await import("./revision-candidate");
				return revisionCandidate(editor, baselineText, current, change, action);
			},
			scrollByDelta: (deltaY: number) => {
				const dom = editor.api.toDOMNode(editor);
				const scroller = dom?.closest(".edda-scroll") as HTMLElement | null;
				if (scroller) scroller.scrollTop += deltaY;
			},
		};
		return () => {
			actionsRef.current = null;
		};
	}, [editor, reviewId, actionsRef, t, baselineText]);

	// First range of every comment / change, for measuring and jumping. Ranges
	// come from the text itself, so positions never depend on whether the
	// decorations have been painted yet.
	const rangesRef = useRef<Map<string, TRange>>(new Map());
	const commentIdsRef = useRef<string[]>([]);
	commentIdsRef.current = comments.map((c) => c.id);
	if (selectedCommentId?.startsWith("chg-")) {
		commentIdsRef.current.push(selectedCommentId);
	}
	const [layoutTick, setLayoutTick] = useState(0);
	const orderRef = useRef("");
	const changesKeyRef = useRef("");
	const costRef = useRef(0);
	const snapshotChildrenRef = useRef<readonly unknown[] | null>(null);
	const view = useReviewView(reviewId);
	const inputsRef = useRef({
		comments,
		reviewEvents,
		baselineText,
		view,
	});
	inputsRef.current = { comments, reviewEvents, baselineText, view };

	const recompute = useCallback(() => {
		const started = performance.now();
		const inputs = inputsRef.current;
		// Comments whose words the author edited follow their ranges before
		// the save carries the new quotes.
		const comments = withMovedAnchors(
			inputs.comments,
			movedCommentAnchors(editor, inputs.comments, commentRefsRef.current),
		);
		const { ranges, changes, aligned } = computeReviewDecorations(
			editor,
			comments,
			inputs.baselineText,
			inputs.reviewEvents,
		);
		syncCommentRefs(editor, commentRefsRef.current, comments, ranges);
		editor.setOption(
			ReviewAnchorPlugin,
			"snapshot",
			buildReviewSnapshot(editor, ranges, {
				aligned,
				comments,
				events: inputs.reviewEvents,
				view: inputs.view,
			}),
		);
		snapshotChildrenRef.current = editor.children;
		// Options do not re-run decorate by themselves.
		editor.api.redecorate();

		const first = new Map<string, TRange>();
		const order = new Map<string, number>();
		ranges.forEach((range, index) => {
			if (first.has(range.anchorId)) return;
			first.set(range.anchorId, range);
			order.set(range.anchorId, index);
		});
		rangesRef.current = first;
		const key = [...order.keys()].join(",");
		if (key !== orderRef.current) {
			orderRef.current = key;
			onAnchorOrder(order);
		}
		const chgKey = changes
			.map((c) => `${c.id}:${c.before}:${c.after}:${c.currentBlock}:${c.actor}`)
			.join("|");
		if (chgKey !== changesKeyRef.current) {
			changesKeyRef.current = chgKey;
			onTrackedChanges(changes);
		}
		costRef.current = performance.now() - started;
		setLayoutTick((tick) => tick + 1);
	}, [editor, onAnchorOrder, onTrackedChanges]);

	// What you see is the diff. Typing inside a paragraph is decorated live
	// by the plugin within Slate's render; the full pass then waits for a
	// pause, because re-splitting text the browser is inserting into moves
	// the caret. Everything else (structure edits, Agent writes, comments,
	// display mode) is applied in the same frame, unless one pass has become
	// expensive.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these values are read through inputsRef and only signal a recompute.
	useLayoutEffect(() => {
		// Never re-split text under an IME composition (Chinese input).
		if (editor.api.isComposing()) return;
		const typing = isInParagraphEdit(
			snapshotChildrenRef.current,
			editor.children,
		);
		if (!typing && costRef.current <= SYNC_DECORATION_BUDGET_MS) {
			recompute();
			return;
		}
		const timer = window.setTimeout(
			recompute,
			typing ? TYPING_IDLE_MS : SLOW_DECORATION_DELAY_MS,
		);
		return () => window.clearTimeout(timer);
	}, [recompute, children, comments, reviewEvents, baselineText, view]);

	// Re-splitting the paragraph under the caret replaces the DOM text node the
	// browser was typing into; the browser then leaves its caret at the start
	// of the paragraph and the next keystroke would follow it. Put the DOM
	// caret back where the editor's selection is.
	// biome-ignore lint/correctness/useExhaustiveDependencies: layoutTick marks a committed decoration change.
	useLayoutEffect(() => {
		const selection = editor.selection;
		if (!selection || !editor.api.isFocused() || editor.api.isComposing())
			return;
		const domSelection = window.getSelection();
		const wanted = editor.api.toDOMRange(selection);
		if (!domSelection || !wanted) return;
		const current = domSelection.rangeCount ? domSelection.getRangeAt(0) : null;
		if (
			current &&
			current.startContainer === wanted.startContainer &&
			current.startOffset === wanted.startOffset &&
			current.endContainer === wanted.endContainer &&
			current.endOffset === wanted.endOffset
		)
			return;
		domSelection.removeAllRanges();
		domSelection.addRange(wanted);
	}, [editor, layoutTick]);

	const highlightedRef = useRef<HTMLElement[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: layoutTick refreshes highlights after decorations replace their DOM nodes.
	useEffect(() => {
		const frame = window.requestAnimationFrame(() => {
			for (const el of highlightedRef.current) delete el.dataset.reviewActive;
			highlightedRef.current = [];
			if (!activeCommentId) return;
			const dom = editor.api.toDOMNode(editor);
			if (!dom) return;
			for (const el of dom.querySelectorAll<HTMLElement>(
				`[data-review-anchor-id="${CSS.escape(activeCommentId)}"]`,
			)) {
				el.dataset.reviewActive = "true";
				highlightedRef.current.push(el);
			}
		});
		return () => window.cancelAnimationFrame(frame);
	}, [editor, activeCommentId, layoutTick]);

	const positionsRef = useRef<Map<string, number>>(new Map());
	const frameTopRef = useRef<number | null>(null);
	const scroller = useCallback(() => {
		const dom = editor.api.toDOMNode(editor);
		return (dom?.closest(".edda-scroll") as HTMLElement | null) ?? null;
	}, [editor]);
	const rangeRect = useCallback(
		(range: TRange): DOMRect | null => {
			try {
				const domRange = editor.api.toDOMRange(range);
				const rect =
					domRange?.getClientRects()[0] ?? domRange?.getBoundingClientRect();
				return rect && (rect.width || rect.height) ? rect : null;
			} catch {
				return null;
			}
		},
		[editor],
	);

	// The editor chunk (`EditorChunk`) holding the start of `range`.
	const chunkOf = useCallback(
		(range: TRange) => {
			const top = editor.children[range.anchor.path[0]];
			return top
				? (editor.api
						.toDOMNode(top)
						?.closest<HTMLElement>("[data-slate-chunk]") ?? null)
				: null;
		},
		[editor],
	);
	// Where each comment sits within its editor chunk, from the last time the
	// chunk was drawn. A chunk the browser skips (`content-visibility: auto`)
	// keeps a placeholder height, yet WebKit still reports positions for text
	// in it as if it were laid out in full, past the placeholder, where other
	// chunks are drawn: only text in drawn chunks is measured.
	const chunkOffsetsRef = useRef<Map<string, number>>(new Map());
	const measurePositions = useCallback(() => {
		if (!selectionEnabledRef.current) return;
		const el = scroller();
		if (!el) return;
		const box = el.getBoundingClientRect();
		const pos = new Map<string, number>();
		for (const id of commentIdsRef.current) {
			const range = rangesRef.current.get(id);
			if (!range) continue;
			const chunk = chunkOf(range);
			const chunkBox = chunk?.getBoundingClientRect();
			if (chunk && chunkBox && !isDrawn(chunk)) {
				// Placed from the chunk; refined once the chunk is drawn.
				const offset = chunkOffsetsRef.current.get(id) ?? 0;
				pos.set(
					id,
					Math.max(12, chunkBox.top + offset - box.top + el.scrollTop - 4),
				);
				continue;
			}
			const rect = rangeRect(range);
			if (!rect) continue;
			if (chunkBox) chunkOffsetsRef.current.set(id, rect.top - chunkBox.top);
			pos.set(id, Math.max(12, rect.top - box.top + el.scrollTop - 4));
		}
		const previous = positionsRef.current;
		if (
			frameTopRef.current !== box.top ||
			previous.size !== pos.size ||
			[...pos].some(([id, y]) => previous.get(id) !== y)
		) {
			positionsRef.current = pos;
			frameTopRef.current = box.top;
			onAnchorPositions({ byId: pos, frameTop: box.top });
		}
		onLayout();
	}, [scroller, chunkOf, rangeRect, onAnchorPositions, onLayout]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: layoutTick marks a new decoration snapshot (inline deletions shift the layout).
	useEffect(() => {
		const frame = window.requestAnimationFrame(measurePositions);
		return () => window.cancelAnimationFrame(frame);
	}, [
		measurePositions,
		layoutTick,
		commentsVisible,
		selectedCommentId,
		selectionEnabled,
	]);

	// Synchronize scroll position and resize with the right margin balloons.
	useEffect(() => {
		const dom = editor.api.toDOMNode(editor);
		const el = scroller();
		if (!dom || !el) return;
		const onScroll = () => {
			onScrollTopChange(el.scrollTop);
		};
		let frame = 0;
		const ro = new ResizeObserver(() => {
			if (!frame)
				frame = window.requestAnimationFrame(() => {
					frame = 0;
					measurePositions();
				});
		});
		ro.observe(dom);
		// A chunk coming on screen: measure the comments in it for real.
		const onChunkShown = () => {
			if (!frame)
				frame = window.requestAnimationFrame(() => {
					frame = 0;
					measurePositions();
				});
		};
		dom.addEventListener("contentvisibilityautostatechange", onChunkShown, {
			capture: true,
		});
		el.addEventListener("scroll", onScroll, { passive: true });
		onScroll();
		return () => {
			ro.disconnect();
			window.cancelAnimationFrame(frame);
			dom.removeEventListener(
				"contentvisibilityautostatechange",
				onChunkShown,
				{
					capture: true,
				},
			);
			el.removeEventListener("scroll", onScroll);
		};
	}, [editor, scroller, measurePositions, onScrollTopChange]);

	// Anchor hover/click ↔ balloon highlight. Clicking a comment's text opens
	// a hidden comment column.
	useEffect(() => {
		const dom = editor.api.toDOMNode(editor);
		if (!dom) return;
		const anchorOf = (event: MouseEvent) =>
			(event.target as HTMLElement).closest<HTMLElement>(
				"[data-review-anchor-id]",
			)?.dataset.reviewAnchorId;
		const onOver = (event: MouseEvent) => {
			const id = anchorOf(event);
			if (id) setActiveComment(id);
		};
		const onClick = (event: MouseEvent) => {
			const id = anchorOf(event);
			// Clicking elsewhere in the text puts the selected card back.
			selectComment(id ?? null);
			if (!id) return;
			setActiveComment(id);
			if (!reviewUi(reviewId).commentsVisible) {
				patchReviewUi(reviewId, { commentsVisible: true });
			}
		};
		dom.addEventListener("mouseover", onOver);
		dom.addEventListener("click", onClick);
		return () => {
			dom.removeEventListener("mouseover", onOver);
			dom.removeEventListener("click", onClick);
		};
	}, [editor, reviewId]);

	// Scroll a requested comment / change into view. A request can arrive
	// before its range exists (an Agent comment that just loaded); it is kept
	// until the next snapshot can place it.
	const pendingRevealRef = useRef<string | null>(null);
	useEffect(() => {
		if (revealRequest) pendingRevealRef.current = revealRequest.commentId;
	}, [revealRequest]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: layoutTick retries a pending reveal once new ranges exist.
	useEffect(() => {
		const id = pendingRevealRef.current;
		const range = id ? rangesRef.current.get(id) : undefined;
		const el = scroller();
		if (!range || !el) return;
		const reveal = (behavior: ScrollBehavior) => {
			const rect = rangeRect(range);
			if (!rect) return false;
			pendingRevealRef.current = null;
			const box = el.getBoundingClientRect();
			el.scrollTo({
				top: el.scrollTop + rect.top - box.top - el.clientHeight / 3,
				behavior,
			});
			return true;
		};
		const chunk = chunkOf(range);
		if (!chunk || isDrawn(chunk)) {
			reveal("smooth");
			return;
		}
		// Text in a skipped chunk has no real position: bring the chunk into
		// view, then place the text once the browser has drawn it. The new
		// heights reach the scroll anchoring (`useChunkScrollAnchor`) only at
		// the end of the frame they were laid out in, so the text is placed a
		// frame later, or the anchoring would move it again.
		el.scrollTop +=
			chunk.getBoundingClientRect().top - el.getBoundingClientRect().top;
		let tries = 0;
		let drawn = false;
		let frame = window.requestAnimationFrame(function retry() {
			if (drawn && reveal("auto")) return;
			drawn = isDrawn(chunk);
			if (++tries < 12) frame = window.requestAnimationFrame(retry);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [revealRequest, layoutTick, scroller, chunkOf, rangeRect]);

	return (
		<ReviewSelectionMenu
			reviewId={reviewId}
			enabled={selectionEnabled}
			libraryCitations={libraryCitations}
		/>
	);
}

type ReviewWorkspaceProps = {
	/** A standalone review host has no paper library to cite from. */
	libraryCitations?: boolean;
	externalMutationPending?: boolean;
	tab: DocTab;
	vaultPath: string;
	reviewId: string;
	editor: DocViewEditorProps;
	/** The tab is showing. Floating UI must not outlive it (see below). */
	active?: boolean;
};

export function ReviewWorkspace({
	tab,
	vaultPath,
	reviewId,
	editor,
	active = true,
	libraryCitations = true,
	externalMutationPending = false,
}: ReviewWorkspaceProps) {
	const { t } = useTranslation(["review", "common"]);
	const doc = useReviewStore((s) => s.docs[reviewId]);
	const ui = useReviewStore((s) => s.ui[reviewId]);
	const isParsing = useReviewStore((s) => Boolean(s.parsing[reviewId]));

	const viewMode = ui?.viewMode ?? "manuscript";
	const changeDisplay = ui?.changeDisplay ?? "markup";
	const commentsVisible = ui?.commentsVisible ?? true;
	const original = changeDisplay === "original";
	const hasPdf = Boolean(doc?.hasPdf);
	const agentSeen = useReviewStore((s) => s.agentSeen[reviewId]);

	const [anchorOrder, setAnchorOrder] = useState<Map<string, number>>(
		() => new Map(),
	);
	const [anchorPositions, setAnchorPositions] = useState<AnchorPositions>(
		() => ({ byId: new Map(), frameTop: 0 }),
	);
	const [trackedChanges, setTrackedChanges] = useState<TrackedChange[]>([]);
	// Layout changes reach the connector without re-rendering the workspace
	// (and with it the editor) on every keystroke.
	const layoutListeners = useRef(new Set<() => void>());
	const notifyLayout = useCallback(() => {
		for (const listener of layoutListeners.current) listener();
	}, []);
	const subscribeLayout = useCallback((listener: () => void) => {
		layoutListeners.current.add(listener);
		return () => {
			layoutListeners.current.delete(listener);
		};
	}, []);
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const [compact, setCompact] = useState(false);
	useLayoutEffect(() => {
		const surface = surfaceRef.current;
		if (!surface) return;
		const observer = new ResizeObserver(([entry]) => {
			const rem = Number.parseFloat(
				getComputedStyle(surface.ownerDocument.documentElement).fontSize,
			);
			setCompact(entry.contentRect.width < 48 * rem);
		});
		observer.observe(surface);
		return () => observer.disconnect();
	}, []);
	const marginContentRef = useRef<HTMLDivElement | null>(null);
	const marginScrollTopRef = useRef(0);
	const syncMarginScroll = useCallback((top: number) => {
		marginScrollTopRef.current = top;
		if (marginContentRef.current) {
			marginContentRef.current.style.transform = `translate3d(0, ${-top}px, 0)`;
		}
	}, []);
	const setMarginContent = useCallback((element: HTMLDivElement | null) => {
		marginContentRef.current = element;
		if (element) {
			element.style.transform = `translate3d(0, ${-marginScrollTopRef.current}px, 0)`;
		}
	}, []);
	const [citePopoverPoint, setCitePopoverPoint] = useState<{
		x: number;
		y: number;
	} | null>(null);

	// The workspace stays mounted behind other tabs, but the citation picker is
	// fixed to the viewport: left open it floats over the next tab and keeps a
	// native Browse view hidden as "covered". Close it when the tab hides.
	useEffect(() => {
		if (!active || original) setCitePopoverPoint(null);
	}, [active, original]);
	const [pdfState, setPdfState] = useState<{
		key: string;
		bytes: ArrayBuffer;
	} | null>(null);
	const pdfKey = `${vaultPath}:${reviewId}:${doc?.pdfFile ?? ""}`;
	const pdfBytes = pdfState?.key === pdfKey ? pdfState.bytes : null;
	const bridgeActionsRef = useRef<BridgeActions | null>(null);
	const [changeBusy, setChangeBusy] = useState(false);
	const changesDisabled = Boolean(
		tab.markdownDirty || changeBusy || externalMutationPending,
	);

	useEffect(() => {
		void openReview(vaultPath, reviewId);
		return () => setCommentDraft(reviewId, null);
	}, [vaultPath, reviewId]);

	// Load PDF bytes on demand; keep the loaded viewer mounted across view switches.
	useEffect(() => {
		if (!hasPdf || !doc?.pdfFile || viewMode === "manuscript" || pdfBytes)
			return;
		const pdfAbs = joinVaultPath(
			vaultPath,
			`${doc.headId ? ".margin/documents" : "reviews"}/${reviewId}/${doc.pdfFile}`,
		);
		let cancelled = false;
		void localFileToArrayBuffer(pdfAbs)
			.then((buf) => {
				if (!cancelled && buf) setPdfState({ key: pdfKey, bytes: buf });
			})
			.catch(() => {
				// Best-effort PDF load
			});
		return () => {
			cancelled = true;
		};
	}, [
		hasPdf,
		doc?.pdfFile,
		doc?.headId,
		viewMode,
		vaultPath,
		reviewId,
		pdfBytes,
		pdfKey,
	]);

	// External disk reseeds (watcher) record an external-change event.
	const seedRef = useRef(tab.seedKey);
	useEffect(() => {
		if (seedRef.current === tab.seedKey) return;
		seedRef.current = tab.seedKey;
		void recordEdit(vaultPath, reviewId, "external");
	}, [tab.seedKey, vaultPath, reviewId]);

	const onPersist = useCallback(
		(path: string, md: string, lastSaved: string) => {
			// Taken with `md`: where the comments point in this text.
			const anchors = bridgeActionsRef.current?.movedCommentAnchors() ?? [];
			return editor.onPersistFile(path, md, lastSaved, (text, saved) =>
				saveReviewManuscript(vaultPath, reviewId, text, saved, anchors),
			);
		},
		[editor, vaultPath, reviewId],
	);

	const handleAcceptChange = useCallback(
		async (change: TrackedChange) => {
			if (!doc || changesDisabled) return;
			setChangeBusy(true);
			let nextBaseline = buildBaselineAfterAcceptSingle(
				doc.baselineText,
				tab.markdownSeed,
				change,
			);
			if (doc.headId) {
				try {
					const candidate = await bridgeActionsRef.current?.resolutionCandidate(
						change,
						tab.markdownSeed,
						"accept",
					);
					if (candidate === null || candidate === undefined) {
						notifyError(t("common:somethingWrong"));
						setChangeBusy(false);
						return;
					}
					nextBaseline = candidate;
				} catch (e) {
					notifyError(errorMessage(e));
					setChangeBusy(false);
					return;
				}
			}
			const ok = await applyTrackedChange(
				vaultPath,
				reviewId,
				nextBaseline,
				undefined,
				"accept-change",
				doc.stamp,
			);
			setChangeBusy(false);
			if (ok && reviewStore.getState().selectedCommentId === change.id)
				selectComment(null);
		},
		[doc, tab.markdownSeed, vaultPath, reviewId, changesDisabled, t],
	);

	const handleRejectChange = useCallback(
		async (change: TrackedChange) => {
			if (changesDisabled) return;
			if (doc?.headId) {
				setChangeBusy(true);
				let next: string | null | undefined;
				try {
					next = await bridgeActionsRef.current?.resolutionCandidate(
						change,
						tab.markdownSeed,
						"reject",
					);
				} catch (e) {
					notifyError(errorMessage(e));
					setChangeBusy(false);
					return;
				}
				if (next === null || next === undefined) {
					notifyError(t("common:somethingWrong"));
					setChangeBusy(false);
					return;
				}
				const ok = await applyTrackedChange(
					vaultPath,
					reviewId,
					doc.baselineText,
					next,
					"reject-change",
					doc.stamp,
				);
				setChangeBusy(false);
				if (ok) selectComment(null);
				return;
			}
			if (bridgeActionsRef.current?.rejectChange(change)) selectComment(null);
		},
		[changesDisabled, doc, tab.markdownSeed, vaultPath, reviewId, t],
	);

	const handleAcceptAll = useCallback(async () => {
		if (changesDisabled) return;
		setChangeBusy(true);
		await checkpointReview(vaultPath, reviewId, "accept-all");
		setChangeBusy(false);
	}, [vaultPath, reviewId, changesDisabled]);

	const handleRejectAll = useCallback(async () => {
		if (!doc || changesDisabled) return;
		setChangeBusy(true);
		await applyTrackedChange(
			vaultPath,
			reviewId,
			doc.baselineText,
			doc.baselineText,
			"reject-all",
			doc.stamp,
		);
		setChangeBusy(false);
	}, [doc, vaultPath, reviewId, changesDisabled]);

	const pickAndExport = async () => {
		if (!isTauri()) return;
		const picked = await openDialog({ directory: true, multiple: false });
		if (typeof picked !== "string" || !picked) return;
		await exportReview(vaultPath, reviewId, picked, t("export.done"));
	};

	const byOrder = useCallback(
		(ids: string[]) =>
			ids
				.filter((id) => anchorOrder.has(id))
				.sort((a, b) => (anchorOrder.get(a) ?? 0) - (anchorOrder.get(b) ?? 0)),
		[anchorOrder],
	);
	const openComments = useMemo(
		() =>
			doc?.comments.filter(
				(c) => c.status === "open" && c.anchor !== "deleted",
			) ?? [],
		[doc],
	);
	const pendingIds = useMemo(
		() => byOrder(openComments.map((c) => c.id)),
		[byOrder, openComments],
	);
	const view = useReviewView(reviewId);
	const agentFocus = view.focus?.agent ?? null;
	const agentIds = useMemo(
		() =>
			byOrder([
				...trackedChanges
					.filter(
						(c) =>
							c.actor === "agent" &&
							(!agentFocus || c.agentName === agentFocus),
					)
					.map((c) => c.id),
				...openComments
					.filter((c) =>
						view.focus ? view.focus.commentIds.has(c.id) : c.actor === "agent",
					)
					.map((c) => c.id),
			]),
		[byOrder, trackedChanges, openComments, agentFocus, view.focus],
	);
	const agentStats = useMemo<AgentStat[]>(() => {
		const stat = (name: string | null): AgentStat => ({
			name,
			hue: name ? view.hues.get(name) : undefined,
			changes: trackedChanges.filter(
				(c) => c.actor === "agent" && (c.agentName ?? null) === name,
			).length,
			comments: openComments.filter(
				(c) => c.actor === "agent" && (c.agent ?? null) === name,
			).length,
		});
		const named = [...view.hues.keys()].map(stat);
		const unnamed = stat(null);
		return unnamed.changes + unnamed.comments ? [...named, unnamed] : named;
	}, [view.hues, trackedChanges, openComments]);
	const unseen = useMemo(
		() => unseenAgentItems(doc, agentSeen),
		[doc, agentSeen],
	);
	const unseenCount = unseen.comments.length + unseen.edits.length;

	const revealItem = useCallback(
		(id: string) => {
			patchReviewUi(reviewId, {
				commentsVisible: true,
				...(isChangeId(id) || reviewUi(reviewId).changeDisplay === "original"
					? { changeDisplay: "markup" as const }
					: {}),
			});
			requestRevealAnchor(id);
		},
		[reviewId],
	);
	const showUnseenAgentItems = () => {
		const newEdits = new Set(unseen.edits);
		const target =
			byOrder(unseen.comments)[0] ??
			byOrder(
				changesWrittenBy(
					trackedChanges,
					doc?.events.filter((event) => newEdits.has(event.id)) ?? [],
				),
			)[0] ??
			agentIds.find(isChangeId) ??
			unseen.comments[0];
		markAgentItemsSeen(reviewId);
		if (target) revealItem(target);
	};

	const manuscriptSurface = (
		<div
			ref={surfaceRef}
			data-compact={compact}
			className="review-surface relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
		>
			<div
				className={cn(
					"review-manuscript h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
					original ? "hidden" : "flex",
				)}
			>
				<Suspense fallback={<EditorSkeleton />}>
					<MarkdownEditor
						readOnly={changeBusy || externalMutationPending}
						className="h-full min-h-0"
						editorOverlay={
							<ReviewEditorBridge
								libraryCitations={libraryCitations}
								actionsRef={bridgeActionsRef}
								onAnchorOrder={setAnchorOrder}
								onAnchorPositions={setAnchorPositions}
								onLayout={notifyLayout}
								onScrollTopChange={syncMarginScroll}
								onTrackedChanges={setTrackedChanges}
								reviewId={reviewId}
							/>
						}
						extraPlugins={REVIEW_PLUGINS}
						filePath={tab.path}
						fontFamily={editor.fontFamily}
						fontSize={editor.fontSize}
						initialMarkdown={tab.markdownSeed}
						key={`review-${tab.id}`}
						lineHeight={editor.lineHeight}
						navigationIntent={tab.navigationIntent}
						onAssetsChanged={editor.onAssetsChanged}
						onDirtyChange={(d) =>
							editor.onTabPatch(tab.id, { markdownDirty: d })
						}
						onPersist={onPersist}
						onRenameHeading={editor.onRenameHeading}
						placeholder={editor.markdownPlaceholder}
						reloadKey={tab.seedKey}
						showToolbar={editor.showToolbar}
					/>
				</Suspense>
			</div>
			{original && doc ? (
				<div
					className="review-manuscript flex h-full min-h-0 min-w-0 flex-1 flex-col"
					data-review-original
				>
					<div className="border-hairline-soft border-b bg-card px-4 py-2 text-muted-foreground text-xs">
						{t("toolbar.originalHint")}
					</div>
					<Suspense fallback={<EditorSkeleton />}>
						<MarkdownEditor
							key={`original-${tab.id}-${doc.revisions.find((r) => r.id === doc.baselineId)?.hash ?? doc.baselineId}`}
							className="min-h-0 flex-1"
							initialMarkdown={doc.baselineText}
							filePath={tab.path}
							readOnly
							fontFamily={editor.fontFamily}
							fontSize={editor.fontSize}
							lineHeight={editor.lineHeight}
						/>
					</Suspense>
				</div>
			) : null}
			{doc && commentsVisible ? (
				<>
					<ReviewColumn
						anchorOrder={anchorOrder}
						anchorPositions={anchorPositions}
						compact={compact}
						hidden={original}
						changes={changeDisplay === "markup" ? trackedChanges : []}
						changesDisabled={changesDisabled}
						onAcceptChange={handleAcceptChange}
						onRejectChange={handleRejectChange}
						newCommentIds={unseen.comments}
						view={view}
						onWheelForward={(dy) => bridgeActionsRef.current?.scrollByDelta(dy)}
						reviewId={reviewId}
						scrollContainerRef={setMarginContent}
						vaultPath={vaultPath}
					/>
					{!compact && !original ? (
						<ReviewConnector
							containerRef={surfaceRef}
							subscribe={subscribeLayout}
						/>
					) : null}
				</>
			) : null}
		</div>
	);

	const pdfSurface = hasPdf ? (
		<div className="relative h-full min-h-0 min-w-0 flex-1 overflow-hidden">
			{pdfBytes ? (
				<Suspense fallback={<EditorSkeleton />}>
					<PdfViewer
						className="h-full w-full"
						docId={`${tab.id}-pdf`}
						isActive={viewMode !== "manuscript"}
						onReviewComment={(sel) => {
							setPdfCommentDraft(reviewId, {
								page: sel.page,
								quote: sel.quote,
							});
						}}
						source={null}
						sourceBytes={pdfBytes}
						vaultPath={vaultPath}
					/>
				</Suspense>
			) : (
				<EditorSkeleton />
			)}
		</div>
	) : null;

	return (
		<div className="review-workspace flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
			{/* Word-style Review Ribbon Bar */}
			<div className="review-ribbon flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-hairline-soft border-b bg-card px-4 py-2 text-xs">
				{/* Dual-mode view switcher (Manuscript / Split / PDF) when PDF is present */}
				{hasPdf ? (
					<>
						<div className="inline-flex h-6 shrink-0 items-center rounded-md bg-muted p-0.5">
							{(
								[
									{
										id: "manuscript",
										icon: FileCode2,
										label: t("toolbar.viewManuscript"),
									},
									{
										id: "split",
										icon: Columns2,
										label: t("toolbar.viewSplit"),
									},
									{ id: "pdf", icon: FileText, label: t("toolbar.viewPdf") },
								] as const
							).map((item) => {
								const Icon = item.icon;
								const active = viewMode === item.id;
								return (
									<button
										key={item.id}
										type="button"
										className={cn(
											"inline-flex h-5 items-center gap-1 rounded-xs px-1.5 font-medium text-[11px] transition-colors",
											active
												? "bg-background text-foreground shadow-xs"
												: "text-muted-foreground hover:text-foreground",
										)}
										onClick={() =>
											patchReviewUi(reviewId, {
												viewMode: item.id as ReviewViewMode,
											})
										}
									>
										<Icon size={12} />
										<span>{item.label}</span>
									</button>
								);
							})}
						</div>
						{isParsing ? (
							<span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
								<Loader2 className="size-3 animate-spin" />
								{t("toolbar.parsingPdf")}
							</span>
						) : (
							<button
								type="button"
								title={t("toolbar.reparsePdf")}
								aria-label={t("toolbar.reparsePdf")}
								className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								onClick={() => void parseReviewPdf(vaultPath, reviewId)}
							>
								<RefreshCw size={12} />
							</button>
						)}
						<div className="h-4 w-px shrink-0 bg-border" />
					</>
				) : null}
				<fieldset
					className="inline-flex h-9 shrink-0 items-center rounded-lg border bg-background p-0.5"
					aria-label={t("toolbar.trackChanges")}
					title={t("toolbar.trackChangesHint")}
				>
					{(
						[
							{ id: "markup", label: t("toolbar.showMarkup") },
							{ id: "clean", label: t("toolbar.showClean") },
							{ id: "original", label: t("toolbar.showOriginal") },
						] as const
					).map((item) => (
						<button
							key={item.id}
							type="button"
							aria-pressed={changeDisplay === item.id}
							title={item.label}
							className={cn(
								"inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors",
								changeDisplay === item.id
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
							onClick={() =>
								patchReviewUi(reviewId, {
									changeDisplay: item.id,
								})
							}
						>
							{item.label}
						</button>
					))}
				</fieldset>
				<div className="h-4 w-px shrink-0 bg-border" />

				{/* New Comment & Insert Citation */}
				<button
					type="button"
					disabled={original}
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground text-[11px] transition-colors hover:bg-accent hover:text-foreground"
					onClick={() => bridgeActionsRef.current?.createCommentFromSelection()}
					title={t("selection.comment")}
				>
					<MessageSquarePlus size={13} />
					<span>{t("toolbar.newComment")}</span>
				</button>
				{libraryCitations ? (
					<button
						type="button"
						disabled={original}
						className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground text-[11px] transition-colors hover:bg-accent hover:text-foreground"
						onClick={(e) => {
							const rect = e.currentTarget.getBoundingClientRect();
							setCitePopoverPoint((prev) =>
								prev ? null : { x: rect.left, y: rect.bottom + 6 },
							);
						}}
						title={t("selection.cite")}
					>
						<Quote size={12} />
						<span>{t("selection.cite")}</span>
					</button>
				) : null}

				<div className="h-4 w-px shrink-0 bg-border" />

				{trackedChanges.length > 0 && !original ? (
					<ReviewChangeControls
						disabled={changesDisabled}
						onReveal={revealItem}
						onAcceptChange={handleAcceptChange}
						onAcceptAll={handleAcceptAll}
						onRejectChange={handleRejectChange}
						onRejectAll={handleRejectAll}
						trackedChanges={trackedChanges}
					/>
				) : null}

				<div className="flex-1" />

				{unseenCount > 0 ? (
					<button
						type="button"
						className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 font-medium text-[11px] text-brand transition-colors hover:bg-brand/20"
						onClick={showUnseenAgentItems}
						title={t("toolbar.showAgentNews")}
					>
						<Sparkles size={12} aria-hidden />
						{[
							unseen.comments.length
								? t("toolbar.newAgentComments", {
										count: unseen.comments.length,
									})
								: null,
							unseen.edits.length
								? t("toolbar.newAgentEdits", { count: unseen.edits.length })
								: null,
						]
							.filter(Boolean)
							.join(" · ")}
					</button>
				) : null}
				{agentStats.length > 0 ? (
					<ReviewAgentMenu
						agents={agentStats}
						focus={agentFocus}
						ids={agentIds}
						onFocus={(agent) => patchReviewUi(reviewId, { agentFocus: agent })}
						onReveal={revealItem}
						step={stepThrough}
					/>
				) : null}
				<ReviewJumper
					count={openComments.length}
					icon={<MessageSquare size={12} aria-hidden />}
					ids={pendingIds}
					label={t("toolbar.nextComment")}
					nextLabel={t("toolbar.nextComment")}
					onReveal={revealItem}
					prevLabel={t("toolbar.prevComment")}
				/>
				<div className="h-4 w-px shrink-0 bg-border" />

				<button
					type="button"
					aria-label={t("export.button")}
					title={t("export.button")}
					className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					onClick={() => void pickAndExport()}
				>
					<Download size={13} />
					<span>{t("export.button")}</span>
				</button>
				<button
					type="button"
					aria-label={t("column.toggle")}
					aria-pressed={commentsVisible}
					title={t("column.toggle")}
					className={cn(
						"flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
						commentsVisible
							? "bg-accent text-foreground"
							: "text-muted-foreground",
					)}
					onClick={() =>
						patchReviewUi(reviewId, { commentsVisible: !commentsVisible })
					}
				>
					<MessageSquare size={13} />
				</button>
			</div>

			{citePopoverPoint ? (
				<CitationPicker
					onClose={() => setCitePopoverPoint(null)}
					onPick={(choice) => {
						bridgeActionsRef.current?.insertCitationToken(choice.token);
						setCitePopoverPoint(null);
					}}
					point={citePopoverPoint}
				/>
			) : null}

			{/* Keep each surface mounted so view changes preserve scroll and editor state. */}
			<div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
				{hasPdf ? (
					<div
						className={cn(
							"h-full min-h-0 min-w-0 flex-col overflow-hidden",
							viewMode === "manuscript" ? "hidden" : "flex",
							viewMode === "split"
								? "w-5/12 min-w-[18rem] border-hairline-soft border-r"
								: "flex-1",
						)}
					>
						{pdfSurface}
					</div>
				) : null}
				<div
					className={cn(
						"min-h-0 min-w-0 flex-1",
						viewMode === "pdf" && hasPdf ? "hidden" : "flex",
					)}
				>
					{manuscriptSurface}
				</div>
				{viewMode === "pdf" && hasPdf && doc && commentsVisible ? (
					<ReviewColumn
						anchorOrder={anchorOrder}
						newCommentIds={unseen.comments}
						view={view}
						reviewId={reviewId}
						vaultPath={vaultPath}
					/>
				) : null}
			</div>
		</div>
	);
}
