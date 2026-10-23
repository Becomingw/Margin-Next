/**
 * Frame URLs for the local HTML preview (`edda-preview://`, see
 * `src-tauri/src/features/vault/preview.rs`). The Host serves a registered
 * Vault root under an opaque id, so a page's relative CSS / JS / images
 * resolve beside it. Windows WebView2 intercepts custom schemes as
 * `http://<scheme>.localhost` (same caveat as `webViewProxyUrl`).
 */
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { vaultRelativePath } from "@/lib/vault/path";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

/** Root id per Vault path; registering is idempotent, so one call each. */
const rootIds = new Map<string, Promise<string>>();

function previewOrigin(): string {
	return typeof navigator !== "undefined" &&
		navigator.userAgent.includes("Windows")
		? "http://edda-preview.localhost"
		: "edda-preview://localhost";
}

/**
 * Frame src for a local file inside `vaultPath`, or null when it cannot be
 * previewed (remote Vault, or a path outside the Vault).
 */
export async function localPreviewUrl(
	vaultPath: string,
	absPath: string,
): Promise<string | null> {
	if (isRemoteVaultHandle(vaultPath)) return null;
	const rel = vaultRelativePath(vaultPath, absPath);
	if (!rel) return null;
	let id = rootIds.get(vaultPath);
	if (!id) {
		id = callApiResult(() => commands.vaultPreviewRoot({ root: vaultPath }));
		rootIds.set(vaultPath, id);
		id.catch(() => rootIds.delete(vaultPath));
	}
	const encoded = rel.split(/[\\/]/).map(encodeURIComponent).join("/");
	return `${previewOrigin()}/${await id}/${encoded}`;
}
