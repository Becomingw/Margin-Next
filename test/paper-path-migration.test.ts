import { expect, it } from "vitest";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	composerScopeKey,
	loadAgentComposerState,
	saveAgentComposerState,
} from "@/lib/agent/composer-state";
import {
	rememberHistoryScope,
	removeHistorySession,
	restoreHistoryScope,
} from "@/lib/agent/conversation-history";
import {
	readPaperConversation,
	rememberPaperConversation,
} from "@/lib/agent/paper-conversations";
import {
	migratePaperConversationStorage,
	paperPathMapper,
} from "@/lib/agent/paper-path-migration";
import {
	restoreReferenceHistory,
	saveReferenceHistory,
} from "@/lib/agent/reference-history";

it("keeps conversation ownership, deletion markers, drafts and reference attachments through flattening", () => {
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
		get length() {
			return data.size;
		},
		key: (i: number) => [...data.keys()][i] ?? null,
	};
	const vault = "/vault";
	const from = "papers/vit/paper";
	const to = "papers/paper";
	const session: ChatSessionHistoryItem = {
		id: "session",
		agentId: "agent",
		agentName: "Agent",
		providerSessionId: "provider",
		source: "local",
		title: "Discussion",
		startedAt: "",
		status: "completed",
		subjectPaperPath: from,
		conversationScope: `paper:${from}`,
		lines: [
			{
				id: "u",
				kind: "user",
				text: "Keep my original question",
				references: [
					{
						id: "r",
						origin: "pdf",
						sourcePath: `${from}/paper.pdf`,
						text: "Original quotation",
						page: 2,
						pinned: true,
					},
				],
			},
		],
	};
	rememberHistoryScope(storage, vault, session);
	rememberPaperConversation(storage, vault, from, session);
	saveReferenceHistory(storage, vault, "agent", "provider", session.lines);
	const scope = composerScopeKey(vault, "agent") ?? "";
	saveAgentComposerState(storage, scope, `draft:paper:${from}`, {
		text: `Question {{m:${from}/NOTES.md}}`,
		mentionedPaths: [`${from}/NOTES.md`],
		selectedSkillIds: [],
		includeSelectedFile: true,
	});
	const deleted = {
		...session,
		id: "deleted",
		providerSessionId: "deleted-provider",
	};
	removeHistorySession(storage, vault, deleted);
	rememberPaperConversation(storage, "/other", from, session);
	const moves = [
		{ from: "papers/vit", to: "notes/paper-collections/vit" },
		{ from, to },
	];
	migratePaperConversationStorage(storage, vault, moves);
	expect(readPaperConversation(storage, vault, to)?.providerSessionId).toBe(
		"provider",
	);
	expect(restoreHistoryScope(storage, vault, session)?.conversationScope).toBe(
		`paper:${to}`,
	);
	expect(restoreHistoryScope(storage, vault, deleted)).toBeNull();
	expect(
		loadAgentComposerState(storage, scope, `draft:paper:${to}`),
	).toMatchObject({
		text: `Question {{m:${to}/NOTES.md}}`,
		mentionedPaths: [`${to}/NOTES.md`],
	});
	const lines = restoreReferenceHistory(
		storage,
		vault,
		"agent",
		"provider",
		session.lines,
	);
	expect(lines[0].text).toBe("Keep my original question");
	expect(lines[0].references?.[0]).toMatchObject({
		sourcePath: `${to}/paper.pdf`,
		text: "Original quotation",
		page: 2,
	});
	expect(readPaperConversation(storage, "/other", from)?.id).toBe("session");
	expect(paperPathMapper(vault, moves).session(session).subjectPaperPath).toBe(
		to,
	);
	const snapshot = [...data];
	migratePaperConversationStorage(storage, vault, moves);
	expect([...data]).toEqual(snapshot);
});
