import { invoke } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import { callApiResult } from "@/lib/core/ipc";
import { type ReviewDoc, reviewStore, setReviewDoc } from "@/lib/review/store";
import { updateTab, workspaceStore } from "@/lib/workspace/store";
import { adoptMarginSnapshot, execute, query } from "./api";

export type AiStatus = {
	listening: boolean;
	workspacePath: string | null;
	reviewId: string | null;
	label: string | null;
	url: string | null;
	config: unknown | null;
};
export type Proposal = {
	id: string;
	baseRevision: string;
	targetRevision: string;
	actor: string;
	agent: string | null;
	status: string;
};
export type UpdatePage = { sequence: number; proposals: Proposal[] };
export type ProposalDetail = Proposal & {
	sequence: number;
	baseMatchesHead: boolean;
	preview: string;
	truncated: boolean;
};
export const aiStatus = () => invoke<AiStatus>("margin_ai_status");
export const stopAi = () => invoke<AiStatus>("margin_ai_stop");
export const startAi = (vaultPath: string, reviewId: string, label: string) =>
	invoke<AiStatus>("margin_ai_start", { vaultPath, reviewId, label });
export const proposalUpdates = (vaultPath: string, reviewId: string) =>
	callApiResult(() =>
		query<UpdatePage>("margin_updates", {
			vaultPath,
			reviewId,
			after: 0,
			limit: 1,
		}),
	);
export const proposalDetail = (
	vaultPath: string,
	reviewId: string,
	proposalId: string,
) =>
	callApiResult(() =>
		query<ProposalDetail>("margin_proposal_detail", {
			vaultPath,
			reviewId,
			proposalId,
		}),
	);

/** A response is not permission to replace an editor that became dirty while
 * the request was in flight. Keep the original base and let CAS report conflict. */
export function receiveProposalResult(
	root: string,
	id: string,
	view: ReviewDoc,
): void {
	const held = reviewStore.getState().docs[id];
	const latest = (held?.sequence ?? 0) > (view.sequence ?? 0) ? held : view;
	if (latest === view) setReviewDoc(id, view);
	for (const tab of workspaceStore.getState().tabs) {
		if (tab.reviewId !== id || tab.markdownDirty) continue;
		const markdown = adoptMarginSnapshot(root, id, latest);
		if (markdown !== tab.markdownSeed)
			updateTab(tab.id, { markdownSeed: markdown, seedKey: tab.seedKey + 1 });
	}
}

export async function decideProposal(
	root: string,
	id: string,
	proposalId: string,
	sequence: number,
	action: "apply" | "dismiss",
): Promise<void> {
	if (
		action === "apply" &&
		workspaceStore
			.getState()
			.tabs.some((t) => t.reviewId === id && t.markdownDirty)
	)
		throw new Error(i18n.t("margin:pending"));
	const result = await callApiResult(() =>
		execute(root, id, {
			kind: action === "apply" ? "apply-proposal" : "dismiss-proposal",
			expectedStamp: String(sequence),
			proposalId,
		}),
	);
	if (action === "apply") receiveProposalResult(root, id, result);
	else {
		const held = reviewStore.getState().docs[id];
		if ((held?.sequence ?? 0) <= (result.sequence ?? 0))
			setReviewDoc(id, result);
	}
}
