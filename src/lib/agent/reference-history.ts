import type { ChatLine } from "@/lib/agent/chat-state";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import {
	parseSelectionContext,
	type SelectionContext,
} from "@/lib/agent/selection-reference";
import { APP_SLUG } from "@/lib/core/app-identity";
import {
	readJsonStorage,
	removeStorageKey,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";

type Entry = {
	userIndex: number;
	text: string;
	references: SelectionContext[];
};
const keyFor = (vault: string, agent: string, session: string) =>
	`${APP_SLUG}-chat-references-v1:${JSON.stringify([vault, agent, session])}`;

export function removeReferenceHistory(
	storage: StorageLike | null,
	vault: string,
	agent: string,
	session: string,
): void {
	removeStorageKey(keyFor(vault, agent, session), storage);
}

/** Small message attachments only; no transcript duplication and no marks writes. */
export function saveReferenceHistory(
	storage: StorageLike | null,
	vault: string,
	agent: string,
	session: string,
	lines: ChatLine[],
): void {
	const entries: Entry[] = [];
	let userIndex = 0;
	for (const line of lines) {
		if (line.kind !== "user") continue;
		if (line.references?.length)
			entries.push({
				userIndex,
				text: stripPromptEnvelopeForDisplay(line.text),
				references: line.references,
			});
		userIndex++;
	}
	if (!entries.length) return; // A history skeleton must not erase attachments.
	const key = keyFor(vault, agent, session);
	const previous = readJsonStorage<unknown>(key, null, storage);
	if (JSON.stringify(previous) !== JSON.stringify(entries))
		writeJsonStorage(key, entries, storage);
}

export function restoreReferenceHistory(
	storage: StorageLike | null,
	vault: string,
	agent: string,
	session: string,
	lines: ChatLine[],
): ChatLine[] {
	const raw = readJsonStorage<unknown>(
		keyFor(vault, agent, session),
		null,
		storage,
	);
	if (!Array.isArray(raw)) return lines;
	let userIndex = 0;
	return lines.map((line) => {
		if (line.kind !== "user") return line;
		const index = userIndex++;
		const entry = raw.find(
			(item) =>
				item &&
				item.userIndex === index &&
				item.text === stripPromptEnvelopeForDisplay(line.text),
		);
		if (!Array.isArray(entry?.references)) return line;
		const references = entry.references
			.map(parseSelectionContext)
			.filter(
				(ref: SelectionContext | null): ref is SelectionContext => ref !== null,
			);
		return references.length ? { ...line, references } : line;
	});
}

/** Provider history can recover a text/page citation even without this device's geometry cache. */
export function referencesFromPrompt(
	prompt: string,
	messageId: string,
): SelectionContext[] {
	return [
		...prompt.matchAll(
			/(?:^|\n\n)Selected text from ([^\n]+):\n((?:>[^\n]*(?:\n|$))+)/g,
		),
	].map((match, index) => {
		const where = match[1];
		const page = where.match(/ \(page (\d+)\)$/);
		return {
			id: `${messageId}-ref-${index}`,
			sourcePath: page ? where.slice(0, page.index) : where,
			text: match[2]
				.trimEnd()
				.split("\n")
				.map((line) => line.replace(/^> ?/, ""))
				.join("\n"),
			origin: page ? ("pdf" as const) : ("markdown" as const),
			...(page ? { page: Number(page[1]) } : {}),
			pinned: true,
		};
	});
}
