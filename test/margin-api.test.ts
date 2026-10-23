import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewApi } from "@/lib/review/api";
import { type ReviewDoc, reviewStore } from "@/lib/review/store";
import { workspaceStore } from "@/lib/workspace/store";
import { createPlaceholderTab } from "@/lib/workspace/tabs";
import { installMarginReviewApi, readMarginManuscript } from "@/margin/api";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
	getPlatformOS: () => "windows",
}));

const view = (head: string, manuscript: string, sequence = 1) =>
	({
		id: "doc",
		headId: head,
		manuscript,
		sequence,
		stamp: String(sequence),
		acknowledgedHead: head,
		acknowledgedSequence: sequence,
	}) as ReviewDoc;
const ok = (data: unknown) => ({ ok: true, data, error: null });

describe("Margin document protocol adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installMarginReviewApi();
		workspaceStore.setState({ tabs: [], activeTabId: null });
		reviewStore.setState({ docs: { doc: view("r1", "old") } });
	});
	it("does not adopt a polled head as the base of a dirty editor", async () => {
		native.invoke.mockResolvedValueOnce(ok(view("r1", "old")));
		await readMarginManuscript("E:/work/.margin/documents/doc/manuscript.md");
		native.invoke.mockResolvedValueOnce(ok(view("r2", "remote", 2)));
		await reviewApi.reviewOpen("E:/work", "doc", null);
		native.invoke.mockResolvedValueOnce(ok(view("r2", "remote", 3)));
		await reviewApi.reviewCommentUpdate(
			"E:/work",
			"doc",
			"thread",
			"reply",
			"hi",
			null,
			null,
		);
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
		expect(native.invoke.mock.calls.at(-1)?.[1].request).toMatchObject({
			expectedHead: "r1",
			lastSaved: "old",
			markdown: "draft",
		});
	});
	it("reuses the command identity after a lost acknowledgement", async () => {
		native.invoke.mockResolvedValueOnce(ok(view("r1", "old")));
		await readMarginManuscript("E:/work/.margin/documents/doc/manuscript.md");
		native.invoke.mockRejectedValueOnce(new Error("connection interrupted"));
		await reviewApi.reviewSaveManuscript(
			"E:/work",
			"doc",
			"draft",
			"old",
			null,
		);
		const first = native.invoke.mock.calls.at(-1)?.[1];
		native.invoke.mockResolvedValueOnce(ok(view("r2", "draft", 2)));
		await reviewApi.reviewSaveManuscript(
			"E:/work",
			"doc",
			"draft",
			"old",
			null,
		);
		expect(native.invoke.mock.calls.at(-1)?.[1].commandId).toBe(
			first.commandId,
		);
		native.invoke.mockResolvedValueOnce(ok(view("r3", "next", 3)));
		await reviewApi.reviewSaveManuscript(
			"E:/work",
			"doc",
			"next",
			"draft",
			null,
		);
		expect(native.invoke.mock.calls.at(-1)?.[1].request.expectedHead).toBe(
			"r2",
		);
	});
	it("keeps a dirty draft when its recovered receipt predates a remote head", async () => {
		native.invoke.mockResolvedValueOnce(ok(view("r1", "old")));
		await readMarginManuscript("E:/work/.margin/documents/doc/manuscript.md");
		native.invoke.mockResolvedValueOnce(
			ok({
				...view("r3", "remote", 3),
				acknowledgedHead: "r2",
				acknowledgedSequence: 2,
			}),
		);
		const result = await reviewApi.reviewSaveManuscript(
			"E:/work",
			"doc",
			"draft",
			"old",
			null,
		);
		expect(result).toMatchObject({
			status: "ok",
			data: { ok: false, error: { code: "manuscript_changed" } },
		});
	});
	it("does not advance the draft base when a late read finds a dirty editor", async () => {
		const path = "E:/work/.margin/documents/doc/manuscript.md";
		native.invoke.mockResolvedValueOnce(ok(view("r1", "old")));
		await readMarginManuscript(path);
		workspaceStore.setState({
			tabs: [
				{
					...createPlaceholderTab(path),
					markdownDirty: true,
					markdownSeed: "old",
				},
			],
		});
		native.invoke.mockResolvedValueOnce(ok(view("r2", "remote", 2)));
		await readMarginManuscript(path);
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
	it("uses the rendered document sequence for review decisions", async () => {
		reviewStore.setState({ docs: { doc: view("r5", "text", 7) } });
		native.invoke.mockResolvedValueOnce(ok(view("r5", "text", 8)));
		await reviewApi.reviewApplyChange(
			"E:/work",
			"doc",
			"new baseline",
			null,
			"accept-change",
			"5",
		);
		expect(native.invoke.mock.calls[0]).toMatchObject([
			"margin_command",
			{
				request: {
					expectedStamp: "5",
					kind: "decide",
					reason: "accept-change",
				},
			},
		]);
	});
});
