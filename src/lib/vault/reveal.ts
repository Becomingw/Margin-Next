import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

/** Platform-aware label key under `sidebar:fileTree.*`. */
export function revealInOsLabelKey():
	| "fileTree.showInFinder"
	| "fileTree.showInExplorer"
	| "fileTree.showInFileManager" {
	if (typeof navigator === "undefined") return "fileTree.showInFinder";
	const p = navigator.platform ?? "";
	const ua = navigator.userAgent ?? "";
	if (/Mac|iPhone|iPad|iPod/.test(p)) return "fileTree.showInFinder";
	if (/Win/.test(p) || /Windows/.test(ua)) return "fileTree.showInExplorer";
	return "fileTree.showInFileManager";
}

/**
 * Reveal a local file or folder in the system file manager
 * (Finder / Explorer / file manager).
 */
export async function revealInFileManager(path: string): Promise<void> {
	const trimmed = path.trim();
	if (!trimmed || trimmed.startsWith(`${VIRTUAL_PATH_PREFIX}`)) {
		throw new Error("Cannot reveal a virtual path.");
	}
	if (!isTauri()) {
		throw new Error("Reveal in file manager requires the desktop app.");
	}
	await revealItemInDir(trimmed);
}

/**
 * Open the system default terminal at `path`.
 * Directories open as cwd; files open their parent directory.
 */
export async function openInTerminal(path: string): Promise<void> {
	const trimmed = path.trim();
	if (!trimmed || trimmed.startsWith(`${VIRTUAL_PATH_PREFIX}`)) {
		throw new Error("Cannot open a virtual path in the terminal.");
	}
	if (!isTauri()) {
		throw new Error("Open in terminal requires the desktop app.");
	}
	await callApi(() => commands.pathOpenInTerminal(trimmed), {
		fallback: "Failed to open terminal.",
	});
}
