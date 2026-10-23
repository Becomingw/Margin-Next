/**
 * Kick the Host layout-model download job when the model is still missing.
 * The JobCenter dedupes with the startup-enqueued `modelDownload` job; the
 * tasks-panel projection shows progress and cancellation.
 */
import { useEffect } from "react";
import { isTauri } from "@/lib/core/tauri";
import { prefetchLayoutModel } from "@/lib/pdf/layout/model";

export function useLayoutModelPrefetch(): void {
	useEffect(() => {
		if (!isTauri()) return;
		prefetchLayoutModel();
	}, []);
}
