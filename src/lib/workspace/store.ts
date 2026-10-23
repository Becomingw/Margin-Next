/**
 * Workspace (dockview panels) state — zustand vanilla.
 * Tabs are the flat panel list; layout is owned by dockview (`toJSON()` blob).
 * Plain modules read the latest snapshot via `getState()`, which replaces the
 * old tabsRef/activeTabIdRef mirrors in App.
 */

import { createStore } from "zustand/vanilla";
import { isTauri } from "@/lib/core/tauri";
import {
	createPlaceholderTab,
	type DocTab,
	loadPersistedTabs,
	patchTab,
	reseedMarkdownTab,
	reseedNotesTab,
} from "@/lib/workspace/tabs";
import type { CenterViewMode } from "@/lib/workspace/viewer";

/** Closed panel remembered for ⇧⌘T (reopen), newest last. */
export type ClosedTab = {
	path: string;
	mode?: CenterViewMode;
};

const CLOSED_TAB_HISTORY = 10;

type WorkspaceStore = {
	/** Open document panels (flat list; layout owned by global dockview). */
	tabs: DocTab[];
	activeTabId: string | null;
	/** Global dockview grid snapshot (panel ids = tab ids). */
	dockLayout: unknown | null;
	/** Most-recently-viewed PDF tab ids kept mounted (see PDF_TAB_MOUNT_LRU). */
	pdfLru: string[];
	/** Most-recently-viewed Markdown editor tab ids kept mounted (see EDITOR_TAB_MOUNT_LRU). */
	editorLru: string[];
	/** Recently closed panels (ephemeral, never persisted). */
	closedTabs: ClosedTab[];
};

export const workspaceStore = createStore<WorkspaceStore>(() => ({
	tabs: [],
	activeTabId: null,
	dockLayout: null,
	pdfLru: [],
	editorLru: [],
	closedTabs: [],
}));

let initialized = false;

/**
 * Seed open panels + layout from localStorage before first paint so
 * DockWorkspace onReady can fromJSON before any membership sync.
 */
export function initWorkspaceStore(): void {
	if (initialized) return;
	initialized = true;
	if (!isTauri()) return;
	const persisted = loadPersistedTabs();
	if (!persisted?.tabs.length) return;
	workspaceStore.setState({
		tabs: persisted.tabs.map((pt) => {
			if (pt.mode === "translation") {
				return {
					...createPlaceholderTab(pt.path, "translation", pt.id),
					kind: "paper",
					title: pt.title || "Translation",
					loaded: true,
				};
			}
			const tab = createPlaceholderTab(pt.path, pt.mode, pt.id);
			// Real-path placeholders default to the folder basename; prefer the
			// persisted title so strips show paper names before hydration.
			return pt.title && tab.kind === "file"
				? { ...tab, title: pt.title }
				: tab;
		}),
		activeTabId: persisted.activeId ?? null,
		dockLayout: persisted.layout ?? null,
	});
}

export function getTabs(): DocTab[] {
	return workspaceStore.getState().tabs;
}

export function getActiveTabId(): string | null {
	return workspaceStore.getState().activeTabId;
}

export function getActiveTab(): DocTab | null {
	const { tabs, activeTabId } = workspaceStore.getState();
	return tabs.find((t) => t.id === activeTabId) ?? null;
}

export function setTabs(
	next: DocTab[] | ((previous: DocTab[]) => DocTab[]),
): void {
	workspaceStore.setState((s) => {
		const tabs = typeof next === "function" ? next(s.tabs) : next;
		return tabs === s.tabs ? s : { tabs };
	});
}

export function setActiveTabId(id: string | null): void {
	workspaceStore.setState((s) =>
		s.activeTabId === id ? s : { activeTabId: id },
	);
}

export function setDockLayout(layout: unknown | null): void {
	workspaceStore.setState((s) =>
		s.dockLayout === layout ? s : { dockLayout: layout },
	);
}

export function setPdfLru(
	next: string[] | ((previous: string[]) => string[]),
): void {
	workspaceStore.setState((s) => {
		const pdfLru = typeof next === "function" ? next(s.pdfLru) : next;
		return pdfLru === s.pdfLru ? s : { pdfLru };
	});
}

export function setEditorLru(
	next: string[] | ((previous: string[]) => string[]),
): void {
	workspaceStore.setState((s) => {
		const editorLru = typeof next === "function" ? next(s.editorLru) : next;
		return editorLru === s.editorLru ? s : { editorLru };
	});
}

/** Remember closed panels so ⇧⌘T can reopen them (newest last). */
export function pushClosedTabs(entries: readonly ClosedTab[]): void {
	if (!entries.length) return;
	workspaceStore.setState((s) => {
		const paths = new Set(entries.map((entry) => entry.path));
		const kept = s.closedTabs.filter((entry) => !paths.has(entry.path));
		return {
			closedTabs: [...kept, ...entries].slice(-CLOSED_TAB_HISTORY),
		};
	});
}

/** Pop the most recently closed panel (null when the history is empty). */
export function takeClosedTab(): ClosedTab | null {
	const { closedTabs } = workspaceStore.getState();
	const last = closedTabs[closedTabs.length - 1];
	if (!last) return null;
	workspaceStore.setState({ closedTabs: closedTabs.slice(0, -1) });
	return last;
}

/** Drop reopen history (paths belong to the vault being left). */
export function clearClosedTabs(): void {
	if (!workspaceStore.getState().closedTabs.length) return;
	workspaceStore.setState({ closedTabs: [] });
}

/** Merge a patch into the panel with the given id. */
export function updateTab(id: string, patch: Partial<DocTab>): void {
	setTabs((prev) => patchTab(prev, id, patch));
}

export function toggleTabHtmlMode(id: string): void {
	setTabs((prev) =>
		prev.map((tab) => {
			if (
				tab.id !== id ||
				tab.paperMeta?.type === "html" ||
				!tab.htmlUrl ||
				(tab.mode !== "pdf" && tab.mode !== "html")
			) {
				return tab;
			}
			return { ...tab, mode: tab.mode === "pdf" ? "html" : "pdf" };
		}),
	);
}

/** Reseed an open paper tab's NOTES after the reader / download writes it. */
export function refreshTabNotes(paperDir: string, content: string): void {
	setTabs((prev) => reseedNotesTab(prev, paperDir, content));
}

/** Reseed an open plain-Markdown tab after an external/Agent write. */
export function refreshTabMarkdown(absPath: string, content: string): void {
	setTabs((prev) => reseedMarkdownTab(prev, absPath, content));
}
