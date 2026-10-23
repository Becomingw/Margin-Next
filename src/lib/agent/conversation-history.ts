import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { APP_SLUG } from "@/lib/core/app-identity";
import {
	readJsonStorage,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";

export const MANAGEMENT_SCOPE = "page:edda:library";

export function conversationScope(
	paper: string | null,
	page: string | null,
): string {
	return paper
		? `paper:${paper.replace(/\\/g, "/")}`
		: page
			? `page:${page.replace(/\\/g, "/")}`
			: MANAGEMENT_SCOPE;
}

export function sessionScope(
	session: ChatSessionHistoryItem,
): string | undefined {
	return (
		session.conversationScope ??
		(session.subjectPaperPath !== undefined
			? conversationScope(session.subjectPaperPath, null)
			: undefined)
	);
}

type Association = { scope?: string; deleted?: boolean };
type Index = Record<string, Association>;
const keyFor = (vault: string) =>
	`${APP_SLUG}-conversation-history-v1:${vault}`;
const identity = (agent: string, id: string) => JSON.stringify([agent, id]);
const idsFor = (session: ChatSessionHistoryItem) => [
	...new Set(
		[session.id, session.providerSessionId].filter((id): id is string =>
			Boolean(id),
		),
	),
];

export function historyStorage(): StorageLike | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function indexFor(storage: StorageLike | null, vault: string): Index {
	const value = readJsonStorage<unknown>(keyFor(vault), {}, storage);
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Index)
		: {};
}

export function isHistoryDeleted(
	storage: StorageLike | null,
	vault: string,
	session: ChatSessionHistoryItem,
): boolean {
	const index = indexFor(storage, vault);
	return idsFor(session).some(
		(id) => index[identity(session.agentId, id)]?.deleted === true,
	);
}

/** Only ownership and deletion markers; native providers retain their transcripts. */
export function rememberHistoryScope(
	storage: StorageLike | null,
	vault: string,
	session: ChatSessionHistoryItem,
): void {
	rememberHistoryScopes(storage, vault, [session]);
}

export function rememberHistoryScopes(
	storage: StorageLike | null,
	vault: string,
	sessions: ChatSessionHistoryItem[],
): void {
	const index = indexFor(storage, vault);
	let changed = false;
	for (const session of sessions) {
		const scope = sessionScope(session);
		if (!scope) continue;
		const keys = idsFor(session).map((id) => identity(session.agentId, id));
		const owner =
			keys
				.map((key) => index[key]?.scope)
				.find((value) => typeof value === "string") ?? scope;
		if (
			keys.some((key) => index[key]?.deleted) ||
			keys.every((key) => index[key]?.scope === owner)
		)
			continue;
		for (const key of keys) index[key] = { scope: owner };
		changed = true;
	}
	if (changed) writeJsonStorage(keyFor(vault), index, storage);
}

export function restoreHistoryScope(
	storage: StorageLike | null,
	vault: string,
	session: ChatSessionHistoryItem,
): ChatSessionHistoryItem | null {
	return restoreIndexedScope(indexFor(storage, vault), session);
}

export function restoreHistoryScopes(
	storage: StorageLike | null,
	vault: string,
	sessions: ChatSessionHistoryItem[],
): ChatSessionHistoryItem[] {
	const index = indexFor(storage, vault);
	return sessions.flatMap((session) => {
		const restored = restoreIndexedScope(index, session);
		return restored ? [restored] : [];
	});
}

function restoreIndexedScope(
	index: Index,
	session: ChatSessionHistoryItem,
): ChatSessionHistoryItem | null {
	const entries = idsFor(session).map(
		(id) => index[identity(session.agentId, id)],
	);
	if (entries.some((entry) => entry?.deleted)) return null;
	const scope =
		entries.find((entry) => typeof entry?.scope === "string")?.scope ??
		sessionScope(session);
	return scope ? { ...session, conversationScope: scope } : session;
}

/** Persist first so a failed storage write cannot silently resurrect a removed row. */
export function removeHistorySession(
	storage: StorageLike | null,
	vault: string,
	session: ChatSessionHistoryItem,
): boolean {
	const index = indexFor(storage, vault);
	for (const id of idsFor(session))
		index[identity(session.agentId, id)] = {
			scope: sessionScope(session),
			deleted: true,
		};
	return writeJsonStorage(keyFor(vault), index, storage);
}

/** Migrate old provider histories using first-turn source evidence, never title guesses. */
export function scopeFromHistory(
	lines: { kind: string; text: string }[],
	papers: string[],
): string {
	const text = lines.find((line) => line.kind === "user")?.text ?? "";
	const paths = [
		...text.matchAll(/Target path \(Vault-relative\): `([^`]+)`/g),
		...text.matchAll(
			/(?:Available Vault sources \(read only when additional context is needed\):|Read these Vault files before answering when relevant:|可用的知识库来源（需要补充上下文时再读取）：|请在回答相关问题前读取以下知识库文件：)\s*\n- ([^\n]+)/g,
		),
		...text.matchAll(/Selected text from ([^\n]+?)(?: \(page \d+\))?:\n/g),
	].map((match) => match[1].trim().replace(/\\/g, "/"));
	for (const path of paths) {
		const paper = papers.find(
			(candidate) => path === candidate || path.startsWith(`${candidate}/`),
		);
		if (paper) return conversationScope(paper, null);
	}
	return MANAGEMENT_SCOPE;
}
