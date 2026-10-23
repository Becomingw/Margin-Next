import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	conversationScope,
	sessionScope,
} from "@/lib/agent/conversation-history";
import { APP_SLUG } from "@/lib/core/app-identity";
import {
	readJsonStorage,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";

export type PaperConversation = {
	id: string;
	agentId: string;
	providerSessionId?: string | null;
	title?: string;
};
const keyFor = (vault: string, paper: string | null, scope?: string) =>
	scope && !scope.startsWith("paper:")
		? `${APP_SLUG}-page-conversation-v1:${JSON.stringify([vault, scope])}`
		: `${APP_SLUG}-paper-conversation-v1:${JSON.stringify([vault, paper])}`;

/** id="draft" retains its Agent; null is a legacy blank draft, undefined is unvisited. */
export function readPaperConversation(
	storage: StorageLike | null,
	vault: string,
	paper: string | null,
	scope?: string,
): PaperConversation | null | undefined {
	const raw = readJsonStorage<unknown>(
		keyFor(vault, paper, scope),
		undefined,
		storage,
	);
	if (raw === null) return null;
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Partial<PaperConversation>;
	return typeof value.id === "string" && typeof value.agentId === "string"
		? {
				id: value.id,
				agentId: value.agentId,
				providerSessionId:
					typeof value.providerSessionId === "string"
						? value.providerSessionId
						: null,
				title: typeof value.title === "string" ? value.title : undefined,
			}
		: undefined;
}

export function rememberPaperConversation(
	storage: StorageLike | null,
	vault: string,
	paper: string | null,
	session: PaperConversation | null,
	scope?: string,
): void {
	writeJsonStorage(
		keyFor(vault, paper, scope),
		session
			? {
					id: session.id,
					agentId: session.agentId,
					providerSessionId: session.providerSessionId,
					title: session.title,
				}
			: null,
		storage,
	);
}

export function conversationForPaper(
	pointer: PaperConversation | null | undefined,
	paper: string | null,
	sessions: ChatSessionHistoryItem[],
	scope?: string,
): ChatSessionHistoryItem | null {
	if (pointer === null) return null;
	if (pointer) {
		const found = sessions.find(
			(session) =>
				session.agentId === pointer.agentId &&
				(session.id === pointer.id ||
					(pointer.providerSessionId &&
						session.providerSessionId === pointer.providerSessionId)),
		);
		if (found) {
			if (scope && sessionScope(found) && sessionScope(found) !== scope)
				return null;
			return {
				...found,
				...(found.subjectPaperPath === undefined
					? { subjectPaperPath: paper }
					: {}),
				...(scope ? { conversationScope: scope } : {}),
			};
		}
		if (!pointer.providerSessionId) return null; // A runtime id is not an ACP resume id.
		return {
			...pointer,
			source: "external",
			title: pointer.title ?? "",
			agentName: pointer.agentId,
			startedAt: "",
			status: "completed",
			lines: [],
			subjectPaperPath: paper,
			conversationScope: scope ?? conversationScope(paper, null),
		};
	}
	return (
		sessions.find((session) =>
			scope
				? sessionScope(session) === scope
				: session.subjectPaperPath === paper,
		) ?? null
	);
}

export function paperDraftKey(paper: string | null): string {
	return paper ? `draft:paper:${paper}` : "draft";
}
