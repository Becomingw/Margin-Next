import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { APP_SLUG } from "@/lib/core/app-identity";
import {
	removeStorageKey,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";
import { joinVaultPath } from "@/lib/vault/path";

type Move = { from: string; to: string };
type EnumerableStorage = StorageLike & {
	readonly length?: number;
	key?: (index: number) => string | null;
};

/** Longest-prefix mapping: a migrated paper wins over its former collection. */
export function paperPathMapper(vault: string, moves: Move[]) {
	const paths = new Map<string, string>();
	for (const move of moves) {
		paths.set(move.from.replace(/\\/g, "/"), move.to.replace(/\\/g, "/"));
		paths.set(
			joinVaultPath(vault, move.from).replace(/\\/g, "/"),
			joinVaultPath(vault, move.to).replace(/\\/g, "/"),
		);
	}
	const path = (value: string): string => {
		const normalized = value.replace(/\\/g, "/");
		let prefix = normalized;
		while (prefix) {
			const target = paths.get(prefix);
			if (target) return target + normalized.slice(prefix.length);
			const slash = prefix.lastIndexOf("/");
			if (slash < 0) break;
			prefix = prefix.slice(0, slash);
		}
		return value;
	};
	const scope = (value: string): string => {
		const prefix = value.startsWith("paper:")
			? "paper:"
			: value.startsWith("page:")
				? "page:"
				: "";
		return prefix ? prefix + path(value.slice(prefix.length)) : value;
	};
	const session = <T extends ChatSessionHistoryItem>(value: T): T => ({
		...value,
		conversationScope: value.conversationScope
			? scope(value.conversationScope)
			: value.conversationScope,
		subjectPaperPath: value.subjectPaperPath
			? path(value.subjectPaperPath)
			: value.subjectPaperPath,
		qaPaperPaths: value.qaPaperPaths?.map(path),
		lines: value.lines.map((line) =>
			line.kind === "user" && line.references
				? {
						...line,
						references: line.references.map((ref) => ({
							...ref,
							sourcePath: path(ref.sourcePath),
						})),
					}
				: line,
		),
	});
	return { path, scope, session };
}

/** Migrate the v1 local caches only. Provider transcripts and user prose stay intact. */
export function migratePaperConversationStorage(
	storage: EnumerableStorage | null,
	vault: string,
	moves: Move[],
): void {
	if (!storage?.key || typeof storage.length !== "number" || !moves.length)
		return;
	const map = paperPathMapper(vault, moves);
	const keys = Array.from({ length: storage.length }, (_, i) =>
		storage.key?.(i),
	).filter((key): key is string => Boolean(key));
	for (const key of keys) {
		try {
			let nextKey = key;
			const raw = storage.getItem(key);
			if (!raw) continue;
			const value = JSON.parse(raw);
			if (
				key === `${APP_SLUG}-conversation-history-v1:${vault}` &&
				value &&
				typeof value === "object"
			) {
				for (const entry of Object.values(value))
					if (
						entry &&
						typeof entry === "object" &&
						"scope" in entry &&
						typeof entry.scope === "string"
					)
						entry.scope = map.scope(entry.scope);
			} else if (
				key.startsWith(`${APP_SLUG}-paper-conversation-v1:`) ||
				key.startsWith(`${APP_SLUG}-page-conversation-v1:`)
			) {
				const colon = key.indexOf(":");
				const parts = JSON.parse(key.slice(colon + 1));
				if (
					!Array.isArray(parts) ||
					parts[0] !== vault ||
					typeof parts[1] !== "string"
				)
					continue;
				parts[1] = key.startsWith(`${APP_SLUG}-paper-`)
					? map.path(parts[1])
					: map.scope(parts[1]);
				nextKey = key.slice(0, colon + 1) + JSON.stringify(parts);
			} else if (key.startsWith(`${APP_SLUG}-chat-references-v1:`)) {
				const owner = JSON.parse(key.slice(key.indexOf(":") + 1));
				if (
					!Array.isArray(owner) ||
					owner[0] !== vault ||
					!Array.isArray(value)
				)
					continue;
				for (const entry of value)
					if (Array.isArray(entry?.references))
						for (const ref of entry.references)
							if (typeof ref?.sourcePath === "string")
								ref.sourcePath = map.path(ref.sourcePath);
			} else if (key.startsWith(`${APP_SLUG}-agent-composer-state-v1:`)) {
				const [owner, id] = key
					.slice(`${APP_SLUG}-agent-composer-state-v1:`.length)
					.split(":");
				if (
					JSON.parse(decodeURIComponent(owner))?.[0] !== vault ||
					!id ||
					!value ||
					typeof value !== "object"
				)
					continue;
				const sessionId = decodeURIComponent(id);
				const nextId = sessionId.startsWith("draft:")
					? `draft:${map.scope(sessionId.slice(6))}`
					: sessionId;
				nextKey = `${APP_SLUG}-agent-composer-state-v1:${owner}:${encodeURIComponent(nextId)}`;
				if (Array.isArray(value.mentionedPaths))
					value.mentionedPaths = value.mentionedPaths.map((p: unknown) =>
						typeof p === "string" ? map.path(p) : p,
					);
				if (typeof value.text === "string")
					value.text = value.text.replace(
						/\{\{m:([^}]+)\}\}/g,
						(_: string, p: string) => `{{m:${map.path(p)}}}`,
					);
			} else continue;
			if (nextKey !== key && storage.getItem(nextKey) !== null) continue; // preserve newer destination drafts
			if (nextKey === key && JSON.stringify(value) === raw) continue;
			if (writeJsonStorage(nextKey, value, storage) && nextKey !== key)
				removeStorageKey(key, storage);
		} catch {
			/* malformed or unavailable cache: preserve the original */
		}
	}
}
