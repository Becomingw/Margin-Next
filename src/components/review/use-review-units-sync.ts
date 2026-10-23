"use client";

import { useEffect } from "react";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { events } from "@/lib/core/bindings";
import { refreshUnits, reloadOpenReview } from "@/lib/review/actions";
import { resetReviewStore, reviewStore } from "@/lib/review/store";
import { applyDiskChange } from "@/lib/workspace/actions";

const DEBOUNCE_MS = 250;
/** Open reviews refresh quickly so Agent comments appear as they land. */
const OPEN_REVIEW_DEBOUNCE_MS = 80;
const REVIEW_STATE = /\/reviews\/([^/]+)\/review\.json$/i;
const REVIEW_MANUSCRIPT = /\/reviews\/([^/]+)\/manuscript\.md$/i;

/**
 * Keep the review unit list (file-tree counts, open-tab state) in step with
 * the vault: reset on vault switch, refresh when the watcher reports changes
 * under `reviews/`, and reload an open review whose `review.json` or
 * manuscript changed.
 * Mount once, next to the file tree.
 */
export function useReviewUnitsSync(vaultPath: string | null): void {
	useEffect(() => {
		resetReviewStore();
		if (vaultPath) void refreshUnits(vaultPath);
	}, [vaultPath]);

	useTauriEvent(events.vaultFileChanged, (payload) => {
		if (!vaultPath) return;
		const touched = payload.paths.some((p) =>
			p.replace(/\\/g, "/").toLowerCase().includes("/reviews/"),
		);
		if (!touched) return;
		scheduleRefresh(vaultPath);
		const open = reviewStore.getState().docs;
		// The general editor reseed waits while the window is unfocused. An
		// open review is what the user watches while an Agent edits it from
		// another app, so its manuscript reloads as long as it is visible.
		const watchingFromElsewhere =
			document.visibilityState === "visible" && !document.hasFocus();
		for (const p of payload.paths) {
			const normalized = p.replace(/\\/g, "/");
			const id = REVIEW_STATE.exec(normalized)?.[1];
			if (id && open[id]) scheduleReload(vaultPath, id);
			const manuscriptOf = REVIEW_MANUSCRIPT.exec(normalized)?.[1];
			if (watchingFromElsewhere && manuscriptOf && open[manuscriptOf]) {
				void applyDiskChange(p);
			}
		}
	});
}

const reloadTimers = new Map<string, number>();
function scheduleReload(vaultPath: string, id: string): void {
	window.clearTimeout(reloadTimers.get(id));
	reloadTimers.set(
		id,
		window.setTimeout(() => {
			reloadTimers.delete(id);
			void reloadOpenReview(vaultPath, id);
		}, OPEN_REVIEW_DEBOUNCE_MS),
	);
}

let timer: number | null = null;
function scheduleRefresh(vaultPath: string): void {
	if (timer !== null) window.clearTimeout(timer);
	timer = window.setTimeout(() => {
		timer = null;
		void refreshUnits(vaultPath);
	}, DEBOUNCE_MS);
}
