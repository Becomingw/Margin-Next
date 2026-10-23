import { expect, it, vi } from "vitest";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	conversationScope,
	MANAGEMENT_SCOPE,
	rememberHistoryScope,
	rememberHistoryScopes,
	removeHistorySession,
	restoreHistoryScope,
	restoreHistoryScopes,
	scopeFromHistory,
} from "@/lib/agent/conversation-history";

function storage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
	};
}
const record = (scope?: string): ChatSessionHistoryItem => ({
	id: "runtime",
	providerSessionId: "provider",
	agentId: "agent",
	title: "Discussion",
	agentName: "Agent",
	source: "local",
	startedAt: "",
	lines: [],
	status: "completed",
	conversationScope: scope,
});

it("restores all conversations by durable provider identity, not just the last selected one", () => {
	const s = storage();
	rememberHistoryScope(s, "/vault", record("paper:papers/a"));
	rememberHistoryScope(s, "/vault", {
		...record("paper:papers/b"),
		id: "runtime-b",
		providerSessionId: "provider-b",
	});
	expect(
		restoreHistoryScope(s, "/vault", { ...record(), id: "provider" })
			?.conversationScope,
	).toBe("paper:papers/a");
	expect(
		restoreHistoryScope(s, "/vault", {
			...record(),
			id: "provider-b",
			providerSessionId: "provider-b",
		})?.conversationScope,
	).toBe("paper:papers/b");
	expect(
		restoreHistoryScope(s, "/other-vault", record())?.conversationScope,
	).toBeUndefined();
});

it("deletion survives native history refresh, late scope writes and runtime-id changes", () => {
	const s = storage();
	const item = record("paper:papers/a");
	rememberHistoryScope(s, "/vault", item);
	expect(removeHistorySession(s, "/vault", item)).toBe(true);
	rememberHistoryScope(s, "/vault", item);
	expect(
		restoreHistoryScope(s, "/vault", { ...item, id: "next-runtime" }),
	).toBeNull();
	expect(
		restoreHistoryScope(s, "/vault", { ...item, agentId: "other-agent" }),
	).not.toBeNull();
	expect(removeHistorySession(null, "/vault", item)).toBe(false);
});

it("keeps paper scopes and management pages distinct", () => {
	expect(conversationScope("papers/a", null)).not.toBe(
		conversationScope("papers/b", null),
	);
	expect(conversationScope(null, "edda:library")).toBe(MANAGEMENT_SCOPE);
	expect(conversationScope(null, "edda:plaza")).not.toBe(MANAGEMENT_SCOPE);
});

it("migrates from first-turn source evidence rather than mentions in later turns", () => {
	const lines = [
		{
			kind: "user",
			text: "Explain\n\nAvailable Vault sources (read only when additional context is needed):\n- papers/a",
		},
		{
			kind: "user",
			text: "Selected text from papers/b (page 1):\n> Other source",
		},
	];
	expect(scopeFromHistory(lines, ["papers/a", "papers/b"])).toBe(
		"paper:papers/a",
	);
	expect(
		scopeFromHistory([{ kind: "user", text: "讨论 papers/a" }], ["papers/a"]),
	).toBe(MANAGEMENT_SCOPE);
	expect(
		scopeFromHistory(
			[
				{
					kind: "user",
					text: "Selected text from papers/a (page 1):\n> Quotation",
				},
			],
			["papers/a"],
		),
	).toBe("paper:papers/a");
});

it("keeps established ownership when later turns attach another paper", () => {
	const s = storage();
	rememberHistoryScope(s, "/vault", record("paper:papers/a"));
	rememberHistoryScope(s, "/vault", {
		...record("paper:papers/b"),
		id: "later-runtime",
	});
	expect(
		restoreHistoryScope(s, "/vault", { ...record(), id: "later-runtime" })
			?.conversationScope,
	).toBe("paper:papers/a");
});

it("reads and writes the scope index once for a whole history page", () => {
	const s = storage();
	const read = vi.spyOn(s, "getItem");
	const write = vi.spyOn(s, "setItem");
	const records = Array.from({ length: 30 }, (_, i) => ({
		...record(`paper:papers/${i}`),
		id: `runtime-${i}`,
		providerSessionId: `provider-${i}`,
	}));
	rememberHistoryScopes(s, "/vault", records);
	expect(read).toHaveBeenCalledTimes(1);
	expect(write).toHaveBeenCalledTimes(1);
	expect(restoreHistoryScopes(s, "/vault", records)).toHaveLength(30);
	expect(read).toHaveBeenCalledTimes(2);
});
