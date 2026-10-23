import { useEffect, useState } from "react";
import { isTauri } from "@/lib/core/tauri";

/**
 * Tracks main-window focus for privacy mode. When the window loses focus,
 * annotation / comment / translate overlays in the PDF viewer fade out so a
 * screenshot of another window (or a switcher thumbnail) never leaks them.
 *
 * There is no public OS "screenshot" event; unfocus is the reliable proxy and
 * needs no permissions. Plain-browser dev builds simply stay visible.
 */
export function usePdfPrivacy(): boolean {
	const [hidden, setHidden] = useState(false);

	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				const win = getCurrentWindow();
				unlisten = await win.onFocusChanged(({ payload: focused }) => {
					if (!disposed) setHidden(!focused);
				});
			} catch {
				// Not a Tauri webview (e.g. `pnpm dev` in a plain browser).
			}
		})();
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	return hidden;
}
