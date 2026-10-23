import { expect, it, vi } from "vitest";
import {
	setActiveTabId,
	setDockLayout,
	setEditorLru,
	setPdfLru,
	setTabs,
	workspaceStore,
} from "@/lib/workspace/store";

it("does not wake workspace subscribers for unchanged activation and retention", () => {
	const before = workspaceStore.getState();
	const listener = vi.fn();
	const off = workspaceStore.subscribe(listener);
	try {
		for (let i = 0; i < 100; i++) {
			setActiveTabId(before.activeTabId);
			setTabs((tabs) => tabs);
			setPdfLru((lru) => lru);
			setEditorLru((lru) => lru);
			setDockLayout(before.dockLayout);
		}
		expect(listener).not.toHaveBeenCalled();
		setActiveTabId("new-panel");
		expect(listener).toHaveBeenCalledTimes(1);
		expect(workspaceStore.getState().activeTabId).toBe("new-panel");
	} finally {
		off();
		workspaceStore.setState(before, true);
	}
});
