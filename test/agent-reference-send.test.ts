import { beforeEach, expect, it, vi } from "vitest";
import {
	type UseAgentSendOptions,
	useAgentSend,
} from "@/components/agent/hooks/use-agent-send";
import { runOnce } from "@/lib/agent";
import type { ChatLine, ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { encodeSelectionToken } from "@/lib/agent/composer-inline-tokens";
import type { SelectionContext } from "@/lib/agent/selection-reference";
import {
	clearSelections,
	currentSelections,
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { writePdfAskThread } from "@/lib/pdf/ask/io";

vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (value: unknown) => [value, vi.fn()],
	useRef: (current: unknown) => ({ current }),
	useCallback: (callback: unknown) => callback,
	useEffect: () => {},
	useLayoutEffect: () => {},
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({ agentPermissionMode: "ask" }),
}));
vi.mock("@/lib/agent", () => ({
	runOnce: vi.fn(),
	cancelAgentRun: vi.fn(),
	loadModelPref: () => null,
	loadReasoningEffortPref: () => null,
}));
vi.mock("@/lib/pdf/agent-trace", () => ({
	bindVisualTracesForTurn: vi.fn(),
	isVisualTraceHistoryId: () => false,
}));
vi.mock("@/lib/pdf/ask/io", () => ({ writePdfAskThread: vi.fn() }));

const reference: SelectionContext = {
	id: "ref",
	sourcePath: "papers/a",
	paperAbsPath: "/vault/papers/a",
	origin: "pdf",
	page: 4,
	rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
	text: "Quoted source",
	pinned: true,
};

function harness(paperPath?: string | null, conversationScope?: string) {
	let lines: ChatLine[] = [];
	let history: ChatSessionHistoryItem[] = [];
	const refs = {
		activeConversationRef: { current: null as string | null },
		activeTabRef: { current: "draft" },
		knownSessionIdsRef: { current: new Set() },
		pendingSessionEventsRef: { current: new Map() },
		pendingSubmissionSessionIdRef: { current: null },
		pendingTerminalEventsRef: { current: new Map() },
		promptHistoryAppliedRef: { current: null },
		promptHistoryDraftRef: { current: "" },
		promptHistoryIndexRef: { current: null },
		selectedAgentIdRef: { current: "agent" },
		sessionContextGenRef: { current: 0 },
		sessionHistoryRef: { current: history },
		submissionGenRef: { current: 0 },
		submittingRef: { current: false },
		switchingRef: { current: false },
		vaultPathRef: { current: "/vault" },
	};
	const options = {
		paperPath,
		conversationScope,
		refs,
		t: (key: string) => key,
		i18nLanguage: "en",
		vaultPath: "/vault",
		lines,
		setLines: (next: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => {
			lines = typeof next === "function" ? next(lines) : next;
		},
		setSessionHistory: (
			next:
				| ChatSessionHistoryItem[]
				| ((prev: ChatSessionHistoryItem[]) => ChatSessionHistoryItem[]),
		) => {
			history = typeof next === "function" ? next(history) : next;
			refs.sessionHistoryRef.current = history;
		},
		setActiveTabId: vi.fn(),
		activeTabId: "draft",
		activeTabIsRunning: false,
		submitting: false,
		switching: false,
		setSubmitting: vi.fn(),
		setStoreSubmitting: vi.fn(),
		setHistoryOpen: vi.fn(),
		setSelectedAgentId: vi.fn(),
		selected: { id: "agent", name: "Agent" },
		registry: { defaultId: "agent" },
		refresh: vi.fn(),
		modelId: null,
		collaborationModeId: null,
		collaborationOptions: [],
		reasoningEffort: null,
		fastAvailable: false,
		fastEnabled: false,
		acpCommandsByAgent: {},
		contextPaths: ["papers/b"],
		selectedVaultPath: "papers/b",
		snapshotComposerState: () => ({
			text: "",
			mentionedPaths: [],
			selectedSkillIds: [],
			includeSelectedFile: true,
		}),
		completeComposerSubmission: vi.fn(),
		setComposerText: vi.fn(),
		setMentionedPaths: vi.fn(),
		setSelectedSkillIds: vi.fn(),
		skills: [],
		activateComposerSession: vi.fn(),
		applyStreamEvent: vi.fn(),
		applyToolEvent: vi.fn(),
		applyPlanEvent: vi.fn(),
		completeSession: vi.fn(),
		failSession: vi.fn(),
		setToolAskUserRequest: vi.fn(),
	} as unknown as UseAgentSendOptions;
	// biome-ignore lint/correctness/useHookAtTopLevel: Send pipeline callback harness; no component rendering.
	const send = useAgentSend(options);
	return { ...send, refs, readLines: () => lines, readHistory: () => history };
}
beforeEach(() => {
	vi.clearAllMocks();
	clearSelections();
});

it("sends reference QA through the complete Agent and never creates an Ask mark", async () => {
	vi.mocked(runOnce).mockResolvedValue({
		sessionId: "runtime-1",
		messageId: "m1",
	});
	const h = harness();
	expect(await h.send(`Why? ${encodeSelectionToken(reference)}`)).toBe(true);
	expect(runOnce).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: "agent",
			workflow: "qa",
			target: "papers/a",
			skillIds: ["paper-qa"],
			permissionMode: "ask",
		}),
	);
	const request = vi.mocked(runOnce).mock.calls[0][0];
	expect(request.prompt).toContain("Quoted source");
	expect(request.prompt).not.toContain("papers/b");
	expect(request.prompt).not.toContain("rects");
	expect(h.readLines()[0]).toMatchObject({
		kind: "user",
		text: "Why?",
		references: [reference],
	});
	expect(writePdfAskThread).not.toHaveBeenCalled();
});

it("resumes the same provider conversation without repeatedly injecting the QA skill", async () => {
	vi.mocked(runOnce)
		.mockResolvedValueOnce({ sessionId: "runtime-1", messageId: "m1" })
		.mockResolvedValueOnce({ sessionId: "runtime-2", messageId: "m2" });
	const h = harness();
	await h.send(`Why? ${encodeSelectionToken(reference)}`);
	h.refs.activeConversationRef.current = "provider-session";
	h.readHistory()[0].providerSessionId = "provider-session";
	await h.send("Explain further", { baseLines: h.readLines() });
	expect(vi.mocked(runOnce).mock.calls[1][0]).toMatchObject({
		sessionId: "provider-session",
		workflow: "qa",
		skillIds: [],
		target: "papers/a",
	});
	expect(vi.mocked(runOnce).mock.calls[1][0].prompt).not.toContain(
		"Earlier turns",
	);
	expect(h.readHistory()[0].lines[0]).toMatchObject({
		references: [reference],
	});
});

it.each([
	undefined,
	1,
	2,
])("refreshes QA instructions at version %s when continuing an existing conversation", async (version) => {
	vi.mocked(runOnce)
		.mockResolvedValueOnce({ sessionId: "runtime-1", messageId: "m1" })
		.mockResolvedValueOnce({ sessionId: "runtime-2", messageId: "m2" });
	const h = harness();
	await h.send(`Why? ${encodeSelectionToken(reference)}`);
	h.refs.activeConversationRef.current = "provider-session";
	h.readHistory()[0].providerSessionId = "provider-session";
	h.readHistory()[0].qaInstructionsVersion = version;
	await h.send("Explain further", { baseLines: h.readLines() });
	expect(vi.mocked(runOnce).mock.calls[1][0]).toMatchObject({
		sessionId: "provider-session",
		skillIds: ["paper-qa"],
	});
	expect(h.readHistory()[0].qaInstructionsVersion).toBe(3);
});

it("does not consume a newly quoted passage when an older send is accepted late", async () => {
	let accept!: (value: Awaited<ReturnType<typeof runOnce>>) => void;
	vi.mocked(runOnce).mockReturnValue(
		new Promise((resolve) => {
			accept = resolve;
		}),
	);
	const h = harness();
	const submitted = h.send(`Why? ${encodeSelectionToken(reference)}`);
	publishSelection({
		text: "A newly selected passage",
		sourcePath: "papers/b",
		origin: "pdf",
		page: 8,
	});
	pinActiveSelection();
	accept({ sessionId: "runtime-late", messageId: "m" });
	await submitted;
	expect(currentSelections()).toHaveLength(1);
	expect(currentSelections()[0].text).toBe("A newly selected passage");
	expect(h.readLines()[0]).toMatchObject({ references: [reference] });
});

it("retains a pending quotation when the Agent rejects the send", async () => {
	vi.mocked(runOnce).mockRejectedValue(new Error("Agent unavailable"));
	publishSelection({
		text: reference.text,
		sourcePath: reference.sourcePath,
		origin: "pdf",
		page: 4,
		paperAbsPath: reference.paperAbsPath,
	});
	pinActiveSelection();
	const h = harness();
	expect(await h.send("Explain this")).toBe(false);
	expect(currentSelections()).toHaveLength(1);
	expect(h.readHistory()).toHaveLength(0);
	expect(writePdfAskThread).not.toHaveBeenCalled();
});

it("does not send or consume a parked quote from another paper", async () => {
	vi.mocked(runOnce).mockResolvedValue({
		sessionId: "runtime-b",
		messageId: "mb",
	});
	publishSelection({
		text: "Parked quote from A",
		sourcePath: "papers/a",
		origin: "pdf",
		page: 4,
	});
	pinActiveSelection();
	const h = harness("papers/b");
	await h.send("Explain paper B");
	expect(vi.mocked(runOnce).mock.calls[0][0].prompt).not.toContain(
		"Parked quote from A",
	);
	expect(currentSelections()).toHaveLength(1);
});

it("uses library management for a page-scoped conversation without bringing a parked PDF quote", async () => {
	vi.mocked(runOnce).mockResolvedValue({
		sessionId: "library-runtime",
		messageId: "m",
	});
	publishSelection({
		text: "Parked quote",
		sourcePath: "papers/a",
		origin: "pdf",
		page: 1,
	});
	pinActiveSelection();
	const h = harness(null, "page:edda:library");
	await h.send("Review my library");
	expect(runOnce).toHaveBeenCalledWith(
		expect.objectContaining({
			workflow: "library",
			target: "edda:library",
			skillIds: [],
		}),
	);
	expect(vi.mocked(runOnce).mock.calls[0][0].prompt).not.toContain(
		"Parked quote",
	);
	expect(h.readHistory()[0].conversationScope).toBe("page:edda:library");
	expect(currentSelections()).toHaveLength(1);
});

it("returns to management after a quoted question in the library conversation", async () => {
	vi.mocked(runOnce)
		.mockResolvedValueOnce({ sessionId: "one", messageId: "m1" })
		.mockResolvedValueOnce({ sessionId: "two", messageId: "m2" });
	const h = harness(null, "page:edda:library");
	await h.send(`Explain ${encodeSelectionToken(reference)}`);
	h.refs.activeConversationRef.current = "provider-session";
	h.readHistory()[0].providerSessionId = "provider-session";
	await h.send("Review the library", { baseLines: h.readLines() });
	expect(vi.mocked(runOnce).mock.calls[0][0].workflow).toBe("qa");
	expect(vi.mocked(runOnce).mock.calls[1][0].workflow).toBe("library");
	expect(h.readHistory()[0].conversationScope).toBe("page:edda:library");
});

it("does not restore a removed file as the workflow target", async () => {
	vi.mocked(runOnce).mockResolvedValue({
		sessionId: "without-file",
		messageId: "m",
	});
	const h = harness("papers/a", "paper:papers/a");
	await h.send("Explain this concept", { contextPaths: [] });
	expect(vi.mocked(runOnce).mock.calls[0][0].target).toBeUndefined();
});
