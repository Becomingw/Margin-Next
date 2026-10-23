import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewStore } from "@/lib/review/store";
import { workspaceStore } from "@/lib/workspace/store";
import { createPlaceholderTab } from "@/lib/workspace/tabs";
import { marginWorkspace, openMarginWorkspace } from "@/margin/workspace";

const native = vi.hoisted(() => ({ open: vi.fn(), list: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.open }));
vi.mock("@/lib/core/bindings", () => ({
	commands: { reviewList: native.list },
}));
vi.mock("@/lib/core/ipc", () => ({
	callApiResult: (fn: () => Promise<unknown>) => fn(),
}));

describe("review-only workspace switching", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		native.open.mockResolvedValue("E:/fictional-next");
		native.list.mockResolvedValue([]);
		marginWorkspace.setState({ root: "E:/fictional-old" });
		workspaceStore.setState({ tabs: [], activeTabId: null });
		reviewStore.setState({
			units: [],
			docs: {},
			ui: {},
			drafts: {},
			agentSeen: {},
		});
	});

	it("does not invoke the Host when the manuscript is unsaved", async () => {
		const tab = {
			...createPlaceholderTab("E:/fictional-old/reviews/draft/manuscript.md"),
			markdownDirty: true,
		};
		workspaceStore.setState({ tabs: [tab], activeTabId: tab.id });
		await expect(openMarginWorkspace("E:/fictional-next")).rejects.toThrow();
		expect(native.open).not.toHaveBeenCalled();
		expect(marginWorkspace.getState().root).toBe("E:/fictional-old");
	});

	it("rechecks unsaved input after the folder read completes", async () => {
		const tab = createPlaceholderTab(
			"E:/fictional-old/reviews/draft/manuscript.md",
		);
		workspaceStore.setState({ tabs: [tab], activeTabId: tab.id });
		native.list.mockImplementation(async () => {
			workspaceStore.setState({ tabs: [{ ...tab, markdownDirty: true }] });
			return [];
		});
		await expect(openMarginWorkspace("E:/fictional-next")).rejects.toThrow();
		expect(workspaceStore.getState().tabs[0].markdownDirty).toBe(true);
		expect(marginWorkspace.getState().root).toBe("E:/fictional-old");
	});

	it("keeps the previous workspace usable when the new folder fails", async () => {
		native.list.mockRejectedValue(new Error("Cannot read workspace"));
		await expect(openMarginWorkspace("E:/fictional-next")).rejects.toThrow(
			"Cannot read workspace",
		);
		expect(marginWorkspace.getState().root).toBe("E:/fictional-old");
	});

	it("uses the native resolved root and clears document state only on success", async () => {
		const tab = createPlaceholderTab(
			"E:/fictional-old/reviews/draft/manuscript.md",
		);
		workspaceStore.setState({ tabs: [tab], activeTabId: tab.id });
		reviewStore.setState({
			activeCommentId: "old-comment",
			selectedCommentId: "old-comment",
		});
		await openMarginWorkspace("E:\\fictional-next");
		expect(native.open).toHaveBeenCalledWith("margin_open_workspace", {
			path: "E:\\fictional-next",
		});
		expect(native.list).toHaveBeenCalledWith("E:/fictional-next");
		expect(marginWorkspace.getState().root).toBe("E:/fictional-next");
		expect(workspaceStore.getState().tabs).toEqual([]);
		expect(reviewStore.getState().activeCommentId).toBeNull();
		expect(reviewStore.getState().selectedCommentId).toBeNull();
	});
});
