import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewApi } from "@/lib/review/api";
import { type ReviewDoc, reviewStore } from "@/lib/review/store";
import { workspaceStore } from "@/lib/workspace/store";
import { createPlaceholderTab } from "@/lib/workspace/tabs";
import { decideProposal, receiveProposalResult } from "@/margin/ai-client";
import { installMarginReviewApi, readMarginManuscript } from "@/margin/api";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
	getPlatformOS: () => "windows",
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
const path = "E:/work/.margin/documents/doc/manuscript.md";
function view(head: string, body: string, seq: number): ReviewDoc {
	return {
		id: "doc",
		title: "Draft",
		format: "margin-review",
		version: 2,
		authors: [],
		hasPdf: false,
		bodyParsed: true,
		createdAt: "2026-10-24T00:00:00Z",
		baselineId: "base",
		baselineText: "old",
		revisions: [],
		comments: [],
		events: [],
		agents: [],
		baselineIncluded: true,
		stamp: String(seq),
		headId: head,
		manuscript: body,
		sequence: seq,
		acknowledgedHead: head,
		acknowledgedSequence: seq,
	};
}
describe("human proposal application", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installMarginReviewApi();
		reviewStore.setState({ docs: { doc: view("r1", "old", 1) } });
		const tab = {
			...createPlaceholderTab(path),
			reviewId: "doc",
			markdownSeed: "old",
		};
		workspaceStore.setState({ tabs: [tab], activeTabId: tab.id });
	});
	it("does not issue apply while the manuscript is dirty", async () => {
		workspaceStore.setState((s) => ({
			tabs: s.tabs.map((t) => ({ ...t, markdownDirty: true })),
		}));
		await expect(
			decideProposal("E:/work", "doc", "p1", 1, "apply"),
		).rejects.toThrow();
		expect(native.invoke).not.toHaveBeenCalled();
	});
	it("preserves a draft that became dirty while awaiting the apply acknowledgement", async () => {
		native.invoke.mockResolvedValueOnce({
			ok: true,
			data: view("r1", "old", 1),
			error: null,
		});
		await readMarginManuscript(path);
		native.invoke.mockImplementationOnce(async () => {
			workspaceStore.setState((s) => ({
				tabs: s.tabs.map((t) => ({ ...t, markdownDirty: true })),
			}));
			return { ok: true, data: view("r2", "proposed", 2), error: null };
		});
		await decideProposal("E:/work", "doc", "p1", 1, "apply");
		expect(workspaceStore.getState().tabs[0]).toMatchObject({
			markdownDirty: true,
			markdownSeed: "old",
		});
		native.invoke.mockResolvedValueOnce({
			ok: false,
			data: null,
			error: { code: "manuscript_changed", message: "stale" },
		});
		await reviewApi.reviewSaveManuscript(
			"E:/work",
			"doc",
			"draft",
			"old",
			null,
		);
		expect(native.invoke.mock.calls.at(-1)?.[1].request.expectedHead).toBe(
			"r1",
		);
	});
	it("does not roll back a newer view when an acknowledgement arrives late", () => {
		reviewStore.setState({ docs: { doc: view("r3", "newer", 3) } });
		receiveProposalResult("E:/work", "doc", view("r2", "older", 2));
		expect(reviewStore.getState().docs.doc.headId).toBe("r3");
		expect(workspaceStore.getState().tabs[0].markdownSeed).toBe("newer");
	});
	it("application reseeds a clean editor and keeps the baseline unaccepted", async () => {
		native.invoke.mockResolvedValueOnce({
			ok: true,
			data: view("r2", "proposed", 2),
			error: null,
		});
		await decideProposal("E:/work", "doc", "p1", 1, "apply");
		expect(native.invoke.mock.calls[0][1].request).toMatchObject({
			kind: "apply-proposal",
			expectedStamp: "1",
			proposalId: "p1",
		});
		expect(workspaceStore.getState().tabs[0]).toMatchObject({
			markdownSeed: "proposed",
			markdownDirty: false,
		});
		expect(reviewStore.getState().docs.doc.baselineText).toBe("old");
	});
});
