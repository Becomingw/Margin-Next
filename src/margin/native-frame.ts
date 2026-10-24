import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { getPlatformOS, isTauri } from "@/lib/core/tauri";

/** The right caption strip belongs to Windows, not to React. Pass resolved
 * semantic colors to its native surface so the header reads as one layer. */
export function useNativeFrame(theme: string | undefined): boolean {
	const enabled = isTauri() && getPlatformOS() === "windows";
	useEffect(() => {
		if (!enabled) return;
		const frame = requestAnimationFrame(() => {
			const header = document.querySelector<HTMLElement>("[data-margin-frame]");
			const ctx = document
				.createElement("canvas")
				.getContext("2d", { willReadFrequently: true });
			if (!header || !ctx) return;
			const style = getComputedStyle(header);
			const rgb = (color: string) => {
				ctx.clearRect(0, 0, 1, 1);
				ctx.fillStyle = color;
				ctx.fillRect(0, 0, 1, 1);
				return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
			};
			void invoke("margin_frame_theme", {
				background: rgb(style.backgroundColor),
				foreground: rgb(style.color),
				dark: theme === "dark",
			}).catch((e) => notifyError(errorMessage(e)));
		});
		return () => cancelAnimationFrame(frame);
	}, [enabled, theme]);
	return enabled;
}
