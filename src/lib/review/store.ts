/**
 * Review workspace state (zustand vanilla): unit list for the file tree and
 * library, per-unit review state for open tabs, and Word-style review UI prefs
 * (PDF/manuscript view and comment filter).
 */

import { createStore } from "zustand/vanilla";
import type {
	ReviewDiffResult,
	ReviewUnitSummary,
	ReviewView_Serialize,
} from "@/lib/core/bindings";

/** A review as the panel holds it: this round's events, always with the
 * baseline text (see `applyReviewView` in actions). */
export type ReviewDoc = ReviewView_Serialize & {
	/** Margin transactional snapshot; absent in the upstream file-backed Host. */
	headId?: string;
	manuscript?: string;
	sequence?: number;
	acknowledgedSequence?: number;
	acknowledgedHead?: string;
};

/** Surface view mode when a review unit carries both a PDF and a manuscript. */
export type ReviewViewMode = "manuscript" | "split" | "pdf";

export type ReviewFilter = "open" | "all";
export type ReviewChangeDisplay = "markup" | "clean" | "original";

/** Selection captured for a not-yet-submitted comment (balloon draft). */
export type CommentDraft = {
	blockId: string | null;
	quote: string;
	prefix: string;
	suffix: string;
	heading: string;
	/** Approximate vertical offset in the editor content for balloon placement. */
	anchorY?: number;
};

/** Selection captured on an open PDF, waiting for a comment body. */
export type PdfCommentDraft = {
	quote: string;
	/** 1-based page. */
	page: number;
};

export type ReviewUiState = {
	/** Manuscript, side-by-side PDF+Manuscript split, or PDF view. */
	viewMode: ReviewViewMode;
	/** Filter for comment balloons. */
	filter: ReviewFilter;
	/** Whether inline revisions are shown or the current manuscript reads cleanly. */
	changeDisplay: ReviewChangeDisplay;
	/** Whether the comment column beside the manuscript is shown. */
	commentsVisible: boolean;
	/** Show only this Agent's revisions and comment threads; null shows all. */
	agentFocus: string | null;
};

const DEFAULT_UI: ReviewUiState = {
	viewMode: "manuscript",
	filter: "all",
	changeDisplay: "markup",
	commentsVisible: true,
	agentFocus: null,
};

/** AI-authored items in a review, by kind. */
export type AgentItems = {
	/** Comments written by AI, or with an AI reply. */
	comments: string[];
	/** AI manuscript edit events. */
	edits: string[];
};

type ReviewStoreState = {
	/** Review units under `reviews/`, refreshed from `review_list`. */
	units: ReviewUnitSummary[];
	unitsLoaded: boolean;
	/** Open-tab review state by unit id. */
	docs: Record<string, ReviewDoc>;
	/** Per-unit Word-style review UI state. */
	ui: Record<string, ReviewUiState>;
	/** Units currently running PDF → Markdown body extraction. */
	parsing: Record<string, boolean>;
	/** Diff cache per unit. */
	diffs: Record<string, ReviewDiffResult | null>;
	/** Comment composer draft per unit (selection captured, body pending). */
	drafts: Record<string, CommentDraft | null>;
	/** PDF selection waiting for a comment body, per unit. */
	pdfDrafts: Record<string, PdfCommentDraft | null>;
	/** Active comment or tracked-change id (balloon ↔ inline highlight). */
	activeCommentId: string | null;
	/** The comment the user picked (its card, its text, or a jump to it):
	 * shown in full and aligned with its text; other cards stay compact. */
	selectedCommentId: string | null;
	/** Bump to ask the editor to scroll this anchor into view. */
	revealRequest: { commentId: string; tick: number } | null;
	/** AI item ids the user has already been shown, per unit. Items present
	 * when a unit first loads count as seen; later ones are announced. */
	agentSeen: Record<string, ReadonlySet<string>>;
};

export const reviewStore = createStore<ReviewStoreState>(() => ({
	units: [],
	unitsLoaded: false,
	docs: {},
	ui: {},
	parsing: {},
	diffs: {},
	drafts: {},
	pdfDrafts: {},
	activeCommentId: null,
	selectedCommentId: null,
	revealRequest: null,
	agentSeen: {},
}));

export function agentItems(doc: ReviewDoc): AgentItems {
	const comments: string[] = [];
	for (const comment of doc.comments) {
		if (comment.status === "deleted") continue;
		if (comment.actor === "agent") comments.push(comment.id);
		for (const reply of comment.replies) {
			if (reply.actor === "agent") comments.push(`${comment.id}/${reply.id}`);
		}
	}
	const edits = doc.events
		.filter((event) => event.kind === "edit" && event.actor === "agent")
		.map((event) => event.id);
	return { comments, edits };
}

/** AI items that arrived after the unit was loaded and were not yet shown. */
export function unseenAgentItems(
	doc: ReviewDoc | undefined,
	seen: ReadonlySet<string> | undefined,
): AgentItems {
	if (!doc || !seen) return { comments: [], edits: [] };
	const all = agentItems(doc);
	return {
		comments: [
			...new Set(
				all.comments.filter((x) => !seen.has(x)).map((x) => x.split("/")[0]),
			),
		],
		edits: all.edits.filter((x) => !seen.has(x)),
	};
}

export function markAgentItemsSeen(id: string): void {
	const doc = reviewStore.getState().docs[id];
	if (!doc) return;
	const all = agentItems(doc);
	reviewStore.setState((s) => ({
		agentSeen: {
			...s.agentSeen,
			[id]: new Set([...all.comments, ...all.edits]),
		},
	}));
}

/** Cheap identity of what the review UI shows, to skip no-op reloads. */
export function reviewDocSignature(doc: ReviewDoc): string {
	const last = doc.events.at(-1);
	return [
		doc.title,
		doc.baselineId,
		doc.manuscriptHash ?? "",
		doc.events.length,
		last?.id ?? "",
		doc.comments
			.map(
				(c) =>
					`${c.id}:${c.updatedAt}:${c.status}:${c.anchor}:${c.replies.length}`,
			)
			.join(","),
	].join("|");
}

export function setUnits(units: ReviewUnitSummary[]): void {
	reviewStore.setState({ units, unitsLoaded: true });
}

export function setReviewDoc(id: string, doc: ReviewDoc): void {
	const openCount = doc.comments.filter(
		(c) => c.status === "open" && c.anchor !== "deleted",
	).length;
	const resolvedCount = doc.comments.filter(
		(c) => c.status === "resolved",
	).length;
	reviewStore.setState((s) => ({
		docs: { ...s.docs, [id]: doc },
		agentSeen: s.agentSeen[id]
			? s.agentSeen
			: (() => {
					const all = agentItems(doc);
					return {
						...s.agentSeen,
						[id]: new Set([...all.comments, ...all.edits]),
					};
				})(),
		units: s.units.some((u) => u.id === id)
			? s.units.map((u) =>
					u.id === id
						? {
								...u,
								title: doc.title,
								hasPdf: doc.hasPdf,
								bodyParsed: doc.bodyParsed,
								openCount,
								resolvedCount,
							}
						: u,
				)
			: s.units,
	}));
}

export function setReviewParsing(id: string, busy: boolean): void {
	reviewStore.setState((s) => ({
		parsing: { ...s.parsing, [id]: busy },
	}));
}

export function removeReviewDoc(id: string): void {
	reviewStore.setState((s) => {
		const docs = { ...s.docs };
		const diffs = { ...s.diffs };
		const drafts = { ...s.drafts };
		const pdfDrafts = { ...s.pdfDrafts };
		const ui = { ...s.ui };
		const parsing = { ...s.parsing };
		const agentSeen = { ...s.agentSeen };
		delete agentSeen[id];
		delete docs[id];
		delete diffs[id];
		delete drafts[id];
		delete pdfDrafts[id];
		delete ui[id];
		delete parsing[id];
		return { docs, diffs, drafts, pdfDrafts, ui, parsing, agentSeen };
	});
}

export function upsertUnit(unit: ReviewUnitSummary): void {
	reviewStore.setState((s) => ({
		units: s.units.some((u) => u.id === unit.id)
			? s.units.map((u) => (u.id === unit.id ? unit : u))
			: [unit, ...s.units],
	}));
}

export function reviewUi(id: string): ReviewUiState {
	return reviewStore.getState().ui[id] ?? DEFAULT_UI;
}

export function patchReviewUi(id: string, patch: Partial<ReviewUiState>): void {
	reviewStore.setState((s) => ({
		ui: { ...s.ui, [id]: { ...DEFAULT_UI, ...s.ui[id], ...patch } },
	}));
}

export function setReviewDiff(id: string, diff: ReviewDiffResult | null): void {
	reviewStore.setState((s) => ({ diffs: { ...s.diffs, [id]: diff } }));
}

export function setCommentDraft(id: string, draft: CommentDraft | null): void {
	reviewStore.setState((s) => ({ drafts: { ...s.drafts, [id]: draft } }));
}

export function setPdfCommentDraft(
	id: string,
	draft: PdfCommentDraft | null,
): void {
	reviewStore.setState((s) => ({ pdfDrafts: { ...s.pdfDrafts, [id]: draft } }));
}

export function setActiveComment(id: string | null): void {
	if (reviewStore.getState().activeCommentId === id) return;
	reviewStore.setState({ activeCommentId: id });
}

export function selectComment(id: string | null): void {
	if (reviewStore.getState().selectedCommentId === id) return;
	reviewStore.setState({ selectedCommentId: id });
}

export function requestRevealAnchor(commentId: string): void {
	reviewStore.setState((s) => ({
		activeCommentId: commentId,
		selectedCommentId: commentId,
		revealRequest: { commentId, tick: (s.revealRequest?.tick ?? 0) + 1 },
	}));
}

export const requestRevealComment = requestRevealAnchor;

export function resetReviewStore(): void {
	reviewStore.setState({
		units: [],
		unitsLoaded: false,
		docs: {},
		ui: {},
		parsing: {},
		diffs: {},
		drafts: {},
		pdfDrafts: {},
		activeCommentId: null,
		selectedCommentId: null,
		revealRequest: null,
		agentSeen: {},
	});
}
