/**
 * Web Storage carried across the product rename. The renamed build gets a new
 * bundle identifier and therefore an empty WebView data directory, so the
 * bridge build exports its own keys to the Host and the renamed build imports
 * them once on first boot (Host side: `edda_core::app_rename`).
 */

import { APP_SLUG, FORMER_APP_SLUG, isRenamed } from "@/lib/core/app-identity";
import { commands, type WebStateEntry } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "key" | "length">;

const EXPORT_THROTTLE_MS = 10_000;

function localStore(): StorageLike | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

function ownsKey(key: string, slug: string): boolean {
	return key.startsWith(`${slug}-`) || key.startsWith(`${slug}.`);
}

/** This build's own Web Storage entries (`<slug>-…` / `<slug>.…`). */
export function collectWebState(
	storage: StorageLike,
	slug = APP_SLUG,
): WebStateEntry[] {
	const entries: WebStateEntry[] = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (!key || !ownsKey(key, slug)) continue;
		const value = storage.getItem(key);
		if (value != null) entries.push({ key, value });
	}
	return entries;
}

/**
 * Rewrite exported entries for this build: the key prefix and the in-app
 * pseudo-path scheme (`<former>:library`, persisted in tabs and sessions)
 * both carry the slug.
 */
export function mapFormerWebState(
	entries: WebStateEntry[],
	former = FORMER_APP_SLUG,
	current: string = APP_SLUG,
): WebStateEntry[] {
	return entries
		.filter(({ key }) => ownsKey(key, former))
		.map(({ key, value }) => ({
			key: current + key.slice(former.length),
			value: value.replaceAll(`${former}:`, `${current}:`),
		}));
}

/** Write entries whose key is still unset; returns how many were written. */
export function restoreWebState(
	storage: Pick<Storage, "getItem" | "setItem">,
	entries: WebStateEntry[],
): number {
	let written = 0;
	for (const { key, value } of entries) {
		if (storage.getItem(key) !== null) continue;
		try {
			storage.setItem(key, value);
			written++;
		} catch {
			// Quota exceeded: keep what fits; the rest falls back to defaults.
		}
	}
	return written;
}

/**
 * Renamed build, before any store seeds from Web Storage: adopt what the
 * bridge build exported. The Host hands the export out once.
 */
export async function importFormerWebState(): Promise<void> {
	const storage = localStore();
	if (!isRenamed || !isTauri() || !storage) return;
	try {
		const entries = await callApi(() => commands.appWebstateImportFormer());
		if (!entries?.length) return;
		const written = restoreWebState(storage, mapFormerWebState(entries));
		logger.info(`op app_rename_webstate_import entries=${written}`);
	} catch (error) {
		logger.warn(`op app_rename_webstate_import failed: ${String(error)}`);
	}
}

/**
 * Bridge build: export now and whenever the window is hidden, so the latest
 * tabs and reading positions reach the renamed build. Returns a disposer.
 */
export function startWebStateExport(): () => void {
	const storage = localStore();
	if (isRenamed || !isTauri() || !storage) return () => {};
	let last = 0;
	const exportNow = () => {
		const now = Date.now();
		if (now - last < EXPORT_THROTTLE_MS) return;
		last = now;
		const entries = collectWebState(storage);
		void callApi(() => commands.appWebstateExport(entries)).catch((error) =>
			logger.warn(`op app_rename_webstate_export failed: ${String(error)}`),
		);
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") exportNow();
	};
	exportNow();
	document.addEventListener("visibilitychange", onVisibility);
	return () => document.removeEventListener("visibilitychange", onVisibility);
}
