import type { WikilinkRepairSuggestion } from "@/lib/doctor/api";

export type WikilinkDraft = WikilinkRepairSuggestion & { selected: boolean };

/** An untouched manual placeholder is not a repair, even after Select all. */
export function hasWikilinkChange(
	draft: Pick<WikilinkDraft, "expected" | "suggestedReplacement">,
): boolean {
	return (
		Boolean(draft.suggestedReplacement.trim()) &&
		draft.suggestedReplacement !== draft.expected
	);
}

export function selectedWikilinkChanges(
	drafts: WikilinkDraft[],
): WikilinkDraft[] {
	return drafts.filter((draft) => draft.selected && hasWikilinkChange(draft));
}

export function toggleWikilinkChanges(
	drafts: WikilinkDraft[],
): WikilinkDraft[] {
	const ready = drafts.filter(hasWikilinkChange);
	const select = !ready.every((draft) => draft.selected);
	return drafts.map((draft) => ({
		...draft,
		selected: select && hasWikilinkChange(draft),
	}));
}
