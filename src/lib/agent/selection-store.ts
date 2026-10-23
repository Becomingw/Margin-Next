/**
 * Editor/PDF text-selection → Agent context (zustand vanilla).
 * `active` mirrors the latest live selection so ⌘L / ⌘K can freeze it; it is
 * never shown in the composer or included in a turn until pinned. `pinned`
 * holds selections the user froze via ⌘L / ⌘K / Ask Agent until they reach the
 * session composer. Draft tokens and sent message attachments own persistence.
 *
 * PDF geometry is used for reference navigation, never automatic mark creation.
 */

import { nanoid } from "nanoid";
import { createStore } from "zustand/vanilla";
import { stripSystemReminder } from "@/lib/agent/prompt-display";
import {
	type ReferenceAnchor,
	referencePromptBlock,
	type SelectionContext,
	type SelectionOrigin,
	sameSelectionReference,
} from "@/lib/agent/selection-reference";
import { toVaultRelative } from "@/lib/core/path";
import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";
import { vaultStore } from "@/lib/vault/store";

export type {
	SelectionContext,
	SelectionOrigin,
} from "@/lib/agent/selection-reference";

type SelectionStore = {
	active: SelectionContext | null;
	pinned: SelectionContext[];
};

const MAX_SELECTION_CHARS = 4000;
const MAX_PINNED = 4;

export const selectionStore = createStore<SelectionStore>(() => ({
	active: null,
	pinned: [],
}));

/** Replace the live selection chip (empty text clears it instead). */
export function publishSelection(input: {
	text: string;
	sourcePath: string;
	origin: SelectionOrigin;
	page?: number;
	rects?: PdfVisualNormalizedRect[];
	paperAbsPath?: string;
	anchors?: ReferenceAnchor[];
	regionIds?: string[];
}): SelectionContext | null {
	const text = stripSystemReminder(input.text.trim())
		.trim()
		.slice(0, MAX_SELECTION_CHARS);
	if (!text) {
		clearActiveSelection(input.origin);
		return null;
	}
	const active: SelectionContext = {
		id: `ref-${nanoid(12)}`,
		text,
		sourcePath: toVaultRelative(
			vaultStore.getState().vaultPath,
			input.sourcePath,
		),
		origin: input.origin,
		page: input.page,
		pinned: false,
		...(input.text.trim().length > MAX_SELECTION_CHARS
			? { truncated: true }
			: {}),
	};
	if (input.anchors?.length)
		active.anchors = input.anchors.map((anchor) => ({
			page: anchor.page,
			rects: anchor.rects.map((r) => ({ ...r })),
		}));
	if (input.regionIds?.length) active.regionIds = [...input.regionIds];
	if (input.rects?.length) {
		active.rects = input.rects.map((r) => ({ ...r }));
	}
	const paperAbs = input.paperAbsPath?.trim();
	if (paperAbs) {
		active.paperAbsPath = paperAbs;
	}
	selectionStore.setState({ active });
	return active;
}

/** Drop the live selection (optionally only when it came from `origin`). */
export function clearActiveSelection(
	origin?: SelectionOrigin,
	sourcePath?: string,
): void {
	const active = selectionStore.getState().active;
	if (!active) return;
	if (origin && active.origin !== origin) return;
	if (
		sourcePath &&
		active.sourcePath !==
			toVaultRelative(vaultStore.getState().vaultPath, sourcePath)
	)
		return;
	selectionStore.setState({ active: null });
}

/** Freeze the live selection as a pinned chip. Returns false when there is none. */
export function pinActiveSelection(): boolean {
	const { active, pinned } = selectionStore.getState();
	if (!active) return false;
	const deduped = pinned.filter(
		(item) => !sameSelectionReference(item, active),
	);
	selectionStore.setState({
		active: null,
		pinned: [...deduped, { ...active, pinned: true }].slice(-MAX_PINNED),
	});
	return true;
}

/** Remove one chip (live or pinned) by id. */
export function removeSelection(id: string): void {
	const { active, pinned } = selectionStore.getState();
	if (active?.id === id) {
		selectionStore.setState({ active: null });
		return;
	}
	selectionStore.setState({ pinned: pinned.filter((item) => item.id !== id) });
}

/** Snapshot pinned chips for a turn (live `active` is staging-only, not sent). */
export function currentSelections(
	paperPath?: string | null,
): SelectionContext[] {
	const pinned = selectionStore.getState().pinned;
	if (paperPath === undefined) return pinned;
	return pinned.filter(
		(reference) =>
			reference.origin !== "pdf" ||
			reference.sourcePath === "PDF" ||
			reference.sourcePath.replace(/\\/g, "/") ===
				paperPath?.replace(/\\/g, "/"),
	);
}

/** Snapshot pinned chips and clear active + pinned after a submitted turn. */
export function consumeSelections(): SelectionContext[] {
	const { active, pinned } = selectionStore.getState();
	const all = pinned;
	if (active || all.length)
		selectionStore.setState({ active: null, pinned: [] });
	return all;
}

/** Drop every selection chip without returning them (e.g. vault switch). */
export function clearSelections(): void {
	const { active, pinned } = selectionStore.getState();
	if (!active && pinned.length === 0) return;
	selectionStore.setState({ active: null, pinned: [] });
}

/** Prompt scaffold in English, matching the PDF-ask quote precedent. */
export function selectionsPromptBlock(selections: SelectionContext[]): string {
	return selections.map(referencePromptBlock).join("\n\n");
}
