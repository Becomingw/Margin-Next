import { beforeEach, expect, it, vi } from "vitest";
import { notifyWarning } from "@/lib/core/notify";
import { startJobCompletionRefresh } from "@/lib/paper/job-refresh";
import { scheduleLibraryRefresh } from "@/lib/paper/library-store";

const listener = vi.hoisted(() => ({
	current: (_payload: unknown) => {},
	other: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("@/i18n", () => ({
	default: {
		t: (key: string, values: { id: string }) => `${key}:${values.id}`,
	},
}));
vi.mock("@/lib/core/bindings", () => ({
	events: {
		jobChanged: "job",
		agentCompleted: "completed",
		agentFailed: "failed",
	},
}));
vi.mock("@/lib/core/notify", () => ({ notifyWarning: vi.fn() }));
vi.mock("@/lib/core/tasks", () => ({
	isTerminalJobState: (state: string) =>
		["succeeded", "failed", "cancelled"].includes(state),
}));
vi.mock("@/lib/core/tauri-events", () => ({
	listenEventSafe: (event: string, callback: (payload: unknown) => void) => {
		if (event === "job") listener.current = callback;
		else listener.other.set(event, callback);
		return vi.fn();
	},
}));
vi.mock("@/lib/paper/library-store", () => ({
	scheduleLibraryRefresh: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	startJobCompletionRefresh();
});

it("refreshes after native Agent tasks without a renderer job", () => {
	listener.other.get("completed")?.({ sessionId: "one" });
	listener.other.get("failed")?.({ sessionId: "two" });
	expect(scheduleLibraryRefresh).toHaveBeenCalledTimes(2);
});

it.each([
	[
		{ warning: "arxiv_rate_limited", arxivId: "2304.07193" },
		"recognizeArxivRateLimited:2304.07193",
	],
	[
		{ warning: "metadata_incomplete", doi: "10.1234/example" },
		"recognizeMetadataIncomplete:10.1234/example",
	],
])("surfaces incomplete recognition and refreshes the catalog", (params, expected) => {
	listener.current({
		job: { kind: "recognizeMetadata", state: "succeeded", params },
	});
	expect(notifyWarning).toHaveBeenCalledWith(
		`sidebar:papersLibrary.${expected}`,
	);
	expect(scheduleLibraryRefresh).toHaveBeenCalledOnce();
});

it("does not warn on cancelled recognition or successful enrichment", () => {
	listener.current({
		job: {
			kind: "recognizeMetadata",
			state: "cancelled",
			params: { warning: "metadata_incomplete" },
		},
	});
	listener.current({
		job: { kind: "recognizeMetadata", state: "succeeded", params: {} },
	});
	expect(notifyWarning).not.toHaveBeenCalled();
	expect(scheduleLibraryRefresh).toHaveBeenCalledTimes(2);
});
