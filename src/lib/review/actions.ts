/**
 * Review workspace IPC actions: unit creation, PDF/Markdown import, automatic
 * PDF body extraction, Word-style Track Changes accept/reject, and comments.
 */

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import type {
	CommentAction,
	CommentAnchor,
	ReviewCommentInput,
	ReviewUnitSummary,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { reviewApi as commands, readReviewManuscript } from "@/lib/review/api";
import {
	type ReviewDoc,
	reviewDocSignature,
	reviewStore,
	setCommentDraft,
	setReviewDiff,
	setReviewDoc,
	setReviewParsing,
	setUnits,
	upsertUnit,
} from "@/lib/review/store";
import { refreshTree } from "@/lib/vault/store";
import { updateTab, workspaceStore } from "@/lib/workspace/store";

/** `review.json` stamp of the view each open review last applied. */
const lastStamps = new Map<string, string>();

/** Hash of the baseline revision a review compares against. */
function baselineHash(doc: ReviewDoc): string | null {
	return doc.revisions.find((r) => r.id === doc.baselineId)?.hash ?? null;
}

/** `view` with the baseline text the store holds for the same baseline, or
 * null when the store has no such text. */
function withHeldBaseline(reviewId: string, view: ReviewDoc): ReviewDoc | null {
	if (view.baselineIncluded) return view;
	const current = reviewStore.getState().docs[reviewId];
	if (!current || baselineHash(current) !== baselineHash(view)) return null;
	return {
		...view,
		baselineText: current.baselineText,
		baselineIncluded: true,
	};
}

/**
 * Put a review view from the Host into the store. Views leave out the
 * baseline text when the operation kept the baseline; the store's text is
 * kept then, or the view is read again with the text if the store has
 * another baseline (another window advanced it).
 */
async function applyReviewView(
	vaultPath: string,
	reviewId: string,
	view: ReviewDoc,
): Promise<void> {
	const doc: ReviewDoc =
		withHeldBaseline(reviewId, view) ??
		(await callApiResult(() => commands.reviewOpen(vaultPath, reviewId, null)));
	const held = reviewStore.getState().docs[reviewId];
	if (
		held?.sequence !== undefined &&
		doc.sequence !== undefined &&
		doc.sequence < held.sequence
	)
		return;
	lastStamps.set(reviewId, doc.stamp);
	setReviewDoc(reviewId, doc);
}

export async function refreshUnits(vaultPath: string): Promise<void> {
	try {
		const units = await callApiResult(() => commands.reviewList(vaultPath));
		setUnits(units);
	} catch (e) {
		notifyError(errorMessage(e));
	}
}

export async function createReview(
	vaultPath: string,
	title: string,
): Promise<ReviewUnitSummary | null> {
	try {
		const unit = await callApiResult(() =>
			commands.reviewCreate(vaultPath, title),
		);
		upsertUnit(unit);
		return unit;
	} catch (e) {
		notifyError(errorMessage(e));
		return null;
	}
}

/**
 * Import local PDF / Markdown / TeX files into `reviews/<id>/`.
 * When `filePaths` is omitted, opens the native file picker.
 * Automatically starts PDF → Markdown extraction for imported PDFs.
 */
export async function importReviewFiles(
	vaultPath: string,
	filePaths?: string[],
	options: { refreshVaultTree?: boolean } = {},
): Promise<ReviewUnitSummary[]> {
	let chosen = filePaths;
	if (!chosen) {
		if (!isTauri()) return [];
		const picked = await openDialog({
			multiple: true,
			filters: [
				{
					name: "Review Papers (PDF / Markdown / TeX)",
					extensions: ["pdf", "md", "markdown", "tex", "txt", "sqlite"],
				},
			],
		});
		if (!picked) return [];
		chosen = Array.isArray(picked) ? picked : [picked];
	}
	if (!chosen.length) return [];

	try {
		const units = await callApiResult(() =>
			commands.reviewImport(vaultPath, chosen),
		);
		for (const u of units) {
			upsertUnit(u);
		}
		if (options.refreshVaultTree !== false) await refreshTree(vaultPath);
		notifySuccess(
			i18n.t("review:import.success", {
				count: units.length,
				defaultValue: `已导入 ${units.length} 篇待审论文`,
			}),
		);
		// Kick off automatic PDF → Markdown extraction in the background.
		for (const u of units) {
			if (u.hasPdf && !u.bodyParsed) {
				void parseReviewPdf(vaultPath, u.id);
			}
		}
		return units;
	} catch (e) {
		notifyError(errorMessage(e));
		return [];
	}
}

/**
 * Parse the unit's local PDF into `manuscript.md` and reseed any open tab
 * for this review unit so the user can immediately review in Markdown or Split mode.
 */
export async function parseReviewPdf(
	vaultPath: string,
	reviewId: string,
): Promise<boolean> {
	if (reviewStore.getState().parsing[reviewId]) return false;
	setReviewParsing(reviewId, true);
	try {
		const doc = await callApiResult(() =>
			commands.reviewParsePdf(vaultPath, reviewId),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		await reseedReviewManuscriptTab(reviewId, doc.title);
		await refreshTree(vaultPath);
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	} finally {
		setReviewParsing(reviewId, false);
	}
}

/** Reload `manuscript.md` into any open workspace tab for `reviewId`. */
async function reseedReviewManuscriptTab(
	reviewId: string,
	title?: string,
): Promise<void> {
	const tabs = workspaceStore
		.getState()
		.tabs.filter((t) => t.reviewId === reviewId && t.mode === "markdown");
	for (const tab of tabs) {
		if (tab.markdownDirty) continue;
		try {
			const text = await readReviewManuscript(tab.path);
			const live = workspaceStore.getState().tabs.find((t) => t.id === tab.id);
			if (!live || live.markdownDirty || live.markdownSeed !== tab.markdownSeed)
				continue;
			updateTab(tab.id, {
				...(title ? { title } : {}),
				markdownSeed: text,
				markdownDirty: false,
				seedKey: (tab.seedKey ?? 0) + 1,
			});
		} catch {
			// Best-effort tab reseed
		}
	}
}

export async function renameReview(
	vaultPath: string,
	reviewId: string,
	title: string,
): Promise<boolean> {
	try {
		const unit = await callApiResult(() =>
			commands.reviewRename(vaultPath, reviewId, title),
		);
		upsertUnit(unit);
		const tabs = workspaceStore
			.getState()
			.tabs.filter((t) => t.reviewId === reviewId);
		for (const tab of tabs) {
			updateTab(tab.id, { title: unit.title });
		}
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	}
}

/** Load (and re-anchor) one unit into the store; seeds the Host edit cache. */
export async function openReview(
	vaultPath: string,
	reviewId: string,
): Promise<void> {
	try {
		const doc = await callApiResult(() =>
			commands.reviewOpen(vaultPath, reviewId, null),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		if (doc.hasPdf && !doc.bodyParsed) {
			void parseReviewPdf(vaultPath, reviewId);
		}
	} catch (e) {
		notifyError(errorMessage(e));
	}
}

const reloadInFlight = new Map<string, boolean>();

/**
 * Re-read an open review after its `review.json` changed on disk (an Agent
 * comment, reply or edit record). One request per unit at a time; a change
 * arriving mid-flight triggers one more read. Identical results are dropped so
 * our own writes echoing through the watcher cost no re-render.
 */
export async function reloadOpenReview(
	vaultPath: string,
	reviewId: string,
): Promise<void> {
	if (!reviewStore.getState().docs[reviewId]) return;
	if (reloadInFlight.has(reviewId)) {
		reloadInFlight.set(reviewId, true);
		return;
	}
	reloadInFlight.set(reviewId, false);
	try {
		const current = reviewStore.getState().docs[reviewId];
		// Our own writes echo through the watcher: nothing to read when
		// `review.json` is still as our last view saw it.
		const stamp = await callApiResult(() =>
			commands.reviewStateStamp(vaultPath, reviewId),
		);
		if (stamp && stamp === lastStamps.get(reviewId)) return;
		const view = await callApiResult(() =>
			commands.reviewOpen(
				vaultPath,
				reviewId,
				current ? baselineHash(current) : null,
			),
		);
		const doc = withHeldBaseline(reviewId, view);
		const latest = reviewStore.getState().docs[reviewId];
		if (
			latest?.sequence !== undefined &&
			doc?.sequence !== undefined &&
			doc.sequence < latest.sequence
		)
			return;
		if (!doc) {
			await applyReviewView(vaultPath, reviewId, view);
		} else if (
			current &&
			reviewDocSignature(current) === reviewDocSignature(doc)
		) {
			lastStamps.set(reviewId, doc.stamp);
		} else {
			lastStamps.set(reviewId, doc.stamp);
			setReviewDoc(reviewId, doc);
		}
	} catch {
		// The unit may be mid-write or deleted; the next change event retries.
	} finally {
		const again = reloadInFlight.get(reviewId);
		reloadInFlight.delete(reviewId);
		if (again) void reloadOpenReview(vaultPath, reviewId);
	}
}

export async function submitCommentDraft(
	vaultPath: string,
	reviewId: string,
	body: string,
): Promise<boolean> {
	const draft = reviewStore.getState().drafts[reviewId] ?? null;
	if (!draft) return false;
	const input: ReviewCommentInput = {
		blockId: draft.blockId,
		quote: draft.quote,
		prefix: draft.prefix,
		suffix: draft.suffix,
		heading: draft.heading,
		body,
	};
	try {
		const doc = await callApiResult(() =>
			commands.reviewCommentAdd(vaultPath, reviewId, input),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		setCommentDraft(reviewId, null);
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	}
}

/**
 * Create a comment anchored to a PDF page. `page` is 1-based; the anchor is
 * the quote plus the page, never a manuscript offset.
 */
export async function addPdfComment(
	vaultPath: string,
	reviewId: string,
	quote: string,
	page: number,
	body: string,
): Promise<boolean> {
	const input: ReviewCommentInput = {
		quote,
		source: "pdf",
		page,
		heading: `p.${page}`,
		body,
	};
	try {
		const doc = await callApiResult(() =>
			commands.reviewCommentAdd(vaultPath, reviewId, input),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	}
}

export async function updateComment(
	vaultPath: string,
	reviewId: string,
	commentId: string,
	action: CommentAction,
	body?: string,
	expectedUpdatedAt?: string,
	/** Edit or delete this reply of the comment instead. */
	replyId?: string,
): Promise<boolean> {
	try {
		const doc = await callApiResult(() =>
			commands.reviewCommentUpdate(
				vaultPath,
				reviewId,
				commentId,
				action,
				body ?? null,
				expectedUpdatedAt ?? null,
				replyId ?? null,
			),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	}
}

/**
 * The review editor's save: writes the manuscript and records the edit in
 * one Host call, under the review's write lock, so an Agent's replacement
 * cannot land in between. "conflict" when the file changed on disk since
 * `lastSaved`.
 */
export async function saveReviewManuscript(
	vaultPath: string,
	reviewId: string,
	markdown: string,
	lastSaved: string,
	/** Comment ranges the author's edits moved, saved with them. */
	anchors: CommentAnchor[],
): Promise<"saved" | "conflict"> {
	const result = await commands.reviewSaveManuscript(
		vaultPath,
		reviewId,
		markdown,
		lastSaved,
		anchors.length ? anchors : null,
	);
	if (
		result.status === "ok" &&
		!result.data.ok &&
		result.data.error?.code === "manuscript_changed"
	) {
		return "conflict";
	}
	const doc = await callApiResult(() => Promise.resolve(result));
	await applyReviewView(vaultPath, reviewId, doc);
	setReviewDiff(reviewId, null);
	return "saved";
}

export async function recordEdit(
	vaultPath: string,
	reviewId: string,
	kind: "edit" | "external",
	/** Comment ranges the author's edits moved, saved with them. */
	anchors: CommentAnchor[] = [],
): Promise<void> {
	try {
		const doc = await callApiResult(() =>
			commands.reviewRecordEdit(
				vaultPath,
				reviewId,
				kind,
				anchors.length ? anchors : null,
			),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		setReviewDiff(reviewId, null);
	} catch (e) {
		notifyError(errorMessage(e));
	}
}

/**
 * Accept or reject one or all tracked changes:
 * - Accepting updates `nextBaseline` (moving the baseline toward the current manuscript).
 * - Rejecting updates `nextManuscript` (reverting the manuscript toward the baseline)
 *   and reseeds the open editor tab.
 */
export async function applyTrackedChange(
	vaultPath: string,
	reviewId: string,
	nextBaseline: string,
	nextManuscript?: string,
	reason?: string,
	expectedStamp?: string,
): Promise<boolean> {
	try {
		const doc = await callApiResult(() =>
			commands.reviewApplyChange(
				vaultPath,
				reviewId,
				nextBaseline,
				nextManuscript ?? null,
				reason ?? null,
				expectedStamp,
			),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		setReviewDiff(reviewId, null);
		if (nextManuscript !== undefined) {
			await reseedReviewManuscriptTab(reviewId);
		}
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	}
}

export async function loadDiff(
	vaultPath: string,
	reviewId: string,
): Promise<void> {
	try {
		const diff = await callApiResult(() =>
			commands.reviewDiff(vaultPath, reviewId),
		);
		setReviewDiff(reviewId, diff);
	} catch (e) {
		notifyError(errorMessage(e));
	}
}

export async function checkpointReview(
	vaultPath: string,
	reviewId: string,
	reason?: string,
): Promise<boolean> {
	try {
		const doc = await callApiResult(() =>
			commands.reviewCheckpoint(vaultPath, reviewId, reason ?? null),
		);
		await applyReviewView(vaultPath, reviewId, doc);
		setReviewDiff(reviewId, null);
		return true;
	} catch (e) {
		notifyError(errorMessage(e));
		return false;
	}
}

export async function exportReview(
	vaultPath: string,
	reviewId: string,
	destDir: string,
	doneMessage: string,
): Promise<void> {
	try {
		const out = await callApiResult(() =>
			commands.reviewExport(vaultPath, reviewId, destDir),
		);
		notifySuccess(`${doneMessage}: ${out}`);
	} catch (e) {
		notifyError(errorMessage(e));
	}
}
