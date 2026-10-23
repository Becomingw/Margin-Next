import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePaperConversations } from "@/components/agent/hooks/use-paper-conversations";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	loadAgentComposerState,
	saveAgentComposerState,
} from "@/lib/agent/composer-state";
import { removeHistorySession } from "@/lib/agent/conversation-history";
import {
	conversationForPaper,
	paperDraftKey,
	readPaperConversation,
	rememberPaperConversation,
} from "@/lib/agent/paper-conversations";

const hooks = vi.hoisted(() => ({
	slots: [] as unknown[],
	cursor: 0,
	layouts: [] as (() => void)[],
	effects: [] as (() => void)[],
}));
type Effect = { deps: unknown[]; cleanup?: () => void; effect: true };
vi.mock("react", async (original) => {
	const effect = (
		queue: (() => void)[],
		callback: () => (() => void) | undefined,
		deps: unknown[],
	) => {
		const index = hooks.cursor++;
		const previous = hooks.slots[index] as Effect | undefined;
		if (
			previous &&
			previous.deps.length === deps.length &&
			deps.every((dep, i) => Object.is(dep, previous.deps[i]))
		)
			return;
		queue.push(() => {
			previous?.cleanup?.();
			hooks.slots[index] = { deps, cleanup: callback(), effect: true };
		});
	};
	return {
		...(await original<typeof import("react")>()),
		useRef: (current: unknown) => {
			const index = hooks.cursor++;
			hooks.slots[index] ??= { current };
			return hooks.slots[index];
		},
		useCallback: (callback: unknown) => callback,
		useLayoutEffect: (
			callback: () => (() => void) | undefined,
			deps: unknown[],
		) => effect(hooks.layouts, callback, deps),
		useEffect: (callback: () => (() => void) | undefined, deps: unknown[]) =>
			effect(hooks.effects, callback, deps),
	};
});

const storageData = new Map<string, string>();
const storage = {
	getItem: (key: string) => storageData.get(key) ?? null,
	setItem: (key: string, value: string) => {
		storageData.set(key, value);
	},
	removeItem: (key: string) => {
		storageData.delete(key);
	},
};
function session(
	id: string,
	paper: string,
	agentId = "agent",
): ChatSessionHistoryItem {
	return {
		id,
		agentId,
		subjectPaperPath: paper,
		providerSessionId: `provider-${id}`,
		source: "local",
		title: `Discussion ${paper}`,
		agentName: agentId,
		startedAt: "",
		status: "completed",
		lines: [{ id: `u-${id}`, kind: "user", text: `Question about ${paper}` }],
	};
}
beforeEach(() => {
	hooks.slots = [];
	hooks.cursor = 0;
	hooks.layouts = [];
	hooks.effects = [];
	storageData.clear();
	vi.stubGlobal("localStorage", storage);
	agentSessionStore.setState({
		sessions: [],
		activeTabId: "draft",
		draftLines: [],
		hydratingSessionId: null,
		submitting: false,
	});
});
afterEach(() => {
	for (const slot of hooks.slots)
		if (slot && typeof slot === "object" && "effect" in slot)
			(slot as Effect).cleanup?.();
	vi.unstubAllGlobals();
});

function harness(paperPath: string | null = "papers/a") {
	const refs = {
		activeTabRef: { current: "draft" },
		activeConversationRef: { current: null as string | null },
		historyHydrationGenRef: { current: 0 },
		sessionContextGenRef: { current: 0 },
		submissionGenRef: { current: 0 },
		submittingRef: { current: false },
		pendingSubmissionSessionIdRef: { current: null },
	};
	const options = {
		vaultPath: "/vault",
		paperPath,
		scopeKey: undefined as string | undefined,
		selectedAgentId: "agent",
		setSelectedAgentId: vi.fn((id: string) => {
			options.selectedAgentId = id;
		}),
		historyReady: true,
		openHistorySession: vi.fn((item: ChatSessionHistoryItem) => {
			refs.activeTabRef.current = item.id;
			refs.activeConversationRef.current = item.providerSessionId ?? null;
			agentSessionStore.getState().hydrateAndActivateSession(item, item.lines);
		}),
		activateComposerSession: vi.fn(),
		restoreSavedComposerSession: vi.fn(),
		setSubmitting: vi.fn(),
		clearTransientUi: vi.fn(),
		refs,
	};
	let startDraft: () => void;
	function render(nextPaper = options.paperPath, scopeKey?: string) {
		options.paperPath = nextPaper;
		options.scopeKey = scopeKey;
		hooks.cursor = 0;
		// biome-ignore lint/correctness/useHookAtTopLevel: deterministic lifecycle harness.
		startDraft = usePaperConversations(options);
		const layouts = hooks.layouts.splice(0);
		for (const effect of layouts) effect();
		const effects = hooks.effects.splice(0);
		for (const effect of effects) effect();
	}
	render();
	return {
		options,
		render,
		newConversation: () => {
			startDraft();
			agentSessionStore.getState().startDraft();
		},
	};
}

it("clears the visible discussion on paper switch and restores the previous paper's conversation", () => {
	const a = session("a", "papers/a");
	agentSessionStore.getState().setSessions([a]);
	rememberPaperConversation(storage, "/vault", "papers/a", a);
	const h = harness();
	expect(agentSessionStore.getState().activeTabId).toBe("a");
	h.render("papers/b");
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
	expect(agentSessionStore.getState().draftLines).toEqual([]);
	const b = session("b", "papers/b");
	agentSessionStore.getState().upsertSession(b);
	h.render("papers/a");
	expect(agentSessionStore.getState().activeTabId).toBe("a");
	expect(h.options.refs.activeConversationRef.current).toBe("provider-a");
	h.render("papers/b");
	expect(agentSessionStore.getState().activeTabId).toBe("b");
	expect(agentSessionStore.getState().sessions).toHaveLength(2);
});

it("new conversation preserves old history but returns to the new draft", () => {
	const a = session("a", "papers/a");
	agentSessionStore.getState().setSessions([a]);
	rememberPaperConversation(storage, "/vault", "papers/a", a);
	const h = harness();
	h.newConversation();
	h.render("papers/b");
	h.render("papers/a");
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
	expect(agentSessionStore.getState().sessions[0].id).toBe("a");
	expect(readPaperConversation(storage, "/vault", "papers/a")?.id).toBe(
		"draft",
	);
});

it("keeps library and other management pages in separate conversations", () => {
	const h = harness(null);
	h.render(null, "page:edda:library");
	const library = {
		...session("library", "unused"),
		subjectPaperPath: null,
		conversationScope: "page:edda:library",
	};
	agentSessionStore.getState().upsertSession(library);
	h.render(null, "page:edda:plaza");
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
	const plaza = {
		...session("plaza", "unused"),
		subjectPaperPath: null,
		conversationScope: "page:edda:plaza",
	};
	agentSessionStore.getState().upsertSession(plaza);
	h.render(null, "page:edda:library");
	expect(agentSessionStore.getState().activeTabId).toBe("library");
	h.render(null, "page:edda:plaza");
	expect(agentSessionStore.getState().activeTabId).toBe("plaza");
});

it("does not resurrect a deleted conversation through its old paper pointer", () => {
	const a = session("a", "papers/a");
	rememberPaperConversation(storage, "/vault", "papers/a", a);
	removeHistorySession(storage, "/vault", a);
	harness();
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
});

it("records a background completion without reopening it over another paper", () => {
	const a = {
		...session("a", "papers/a"),
		providerSessionId: null,
		status: "running" as const,
	};
	agentSessionStore.getState().setSessions([a]);
	rememberPaperConversation(storage, "/vault", "papers/a", a);
	const h = harness();
	h.render("papers/b");
	agentSessionStore
		.getState()
		.setSessions([
			{ ...a, status: "completed", providerSessionId: "durable-a" },
		]);
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
	expect(
		readPaperConversation(storage, "/vault", "papers/a")?.providerSessionId,
	).toBe("durable-a");
	h.render("papers/a");
	expect(h.options.refs.activeConversationRef.current).toBe("durable-a");
});

it("waits for the right Agent's history and cancels a stale pending restore on another switch", () => {
	rememberPaperConversation(storage, "/vault", "papers/a", {
		id: "a",
		agentId: "other-agent",
		providerSessionId: "provider-a",
	});
	const h = harness();
	expect(h.options.setSelectedAgentId).toHaveBeenCalledWith("other-agent");
	h.options.historyReady = false;
	h.render();
	expect(h.options.openHistorySession).not.toHaveBeenCalled();
	h.render("papers/b");
	h.options.historyReady = true;
	h.render();
	expect(h.options.openHistorySession).not.toHaveBeenCalled();
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
});

it("does not turn a runtime-only bookmark into an ACP resume request", () => {
	expect(
		conversationForPaper({ id: "runtime", agentId: "agent" }, "papers/a", []),
	).toBeNull();
});

it("restores the draft's Agent before loading its per-paper composer state", () => {
	rememberPaperConversation(storage, "/vault", "papers/a", {
		id: "draft",
		agentId: "draft-agent",
	});
	const h = harness();
	expect(h.options.setSelectedAgentId).toHaveBeenCalledWith("draft-agent");
	h.render();
	expect(agentSessionStore.getState().activeTabId).toBe("draft");
	expect(h.options.openHistorySession).not.toHaveBeenCalled();
	expect(readPaperConversation(storage, "/vault", "papers/a")?.agentId).toBe(
		"draft-agent",
	);
});

it("keeps unsent paper drafts and quoted text in distinct composer storage slots", () => {
	const a = {
		text: "Question for A {{sel:quote-a}}",
		mentionedPaths: [],
		selectedSkillIds: [],
		includeSelectedFile: true,
	};
	const b = { ...a, text: "Question for B {{sel:quote-b}}" };
	saveAgentComposerState(storage, "vault-agent", paperDraftKey("papers/a"), a);
	saveAgentComposerState(storage, "vault-agent", paperDraftKey("papers/b"), b);
	expect(
		loadAgentComposerState(storage, "vault-agent", paperDraftKey("papers/a")),
	).toEqual(a);
	expect(
		loadAgentComposerState(storage, "vault-agent", paperDraftKey("papers/b")),
	).toEqual(b);
});
