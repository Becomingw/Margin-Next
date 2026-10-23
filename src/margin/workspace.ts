import { invoke } from "@tauri-apps/api/core";
import { createStore } from "zustand/vanilla";
import i18n from "@/i18n";
import { callApiResult } from "@/lib/core/ipc";
import { reviewApi as commands } from "@/lib/review/api";
import { reviewStore, setUnits } from "@/lib/review/store";
import { workspaceStore } from "@/lib/workspace/store";

export const marginWorkspace = createStore<{ root: string | null }>(() => ({
	root: null,
}));

/** The native workspace-open action, independent of how a folder is picked. */
export async function openMarginWorkspace(path: string): Promise<void> {
	const requireClean = () => {
		if (workspaceStore.getState().tabs.some((tab) => tab.markdownDirty)) {
			throw new Error(i18n.t("margin:pending"));
		}
	};
	requireClean();
	const root = await invoke<string>("margin_open_workspace", { path });
	const units = await callApiResult(() => commands.reviewList(root));
	// The picker / disk reads can outlive an edit in the current document.
	requireClean();
	workspaceStore.setState({ tabs: [], activeTabId: null });
	reviewStore.setState({
		docs: {},
		ui: {},
		drafts: {},
		pdfDrafts: {},
		activeCommentId: null,
		selectedCommentId: null,
		agentSeen: {},
	});
	setUnits(units);
	marginWorkspace.setState({ root });
}
