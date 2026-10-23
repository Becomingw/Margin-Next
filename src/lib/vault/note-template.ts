/**
 * Vault NOTES.md starter template (`.edda/templates/NOTES.md`).
 * Used by the `custom` paperNoteMode; seeded on demand from Settings → General.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";

export type NotesTemplateSeedResult = {
	/** `false` when `.edda/templates/NOTES.md` already exists. */
	created: boolean;
};

/** Seed the starter template in `vaultPath`; existing files are left untouched. */
export async function notesTemplateSeed(
	vaultPath: string,
): Promise<NotesTemplateSeedResult> {
	return callApi(() => commands.notesTemplateSeed(vaultPath));
}
