import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

export type FinderServiceStatus = {
	supported: boolean;
	installed: boolean;
	installPath: string | null;
	appBundlePath: string | null;
	current: boolean;
	message: string | null;
};

export function fetchFinderServiceStatus(): Promise<FinderServiceStatus> {
	return callApi(() => commands.finderServiceStatus(), {
		fallback: "Failed to read Finder service status",
	});
}
export function installFinderService(): Promise<FinderServiceStatus> {
	return callApi(() => commands.finderServiceInstall(), {
		fallback: "Failed to install Finder service",
	});
}
export function uninstallFinderService(): Promise<FinderServiceStatus> {
	return callApi(() => commands.finderServiceUninstall(), {
		fallback: "Failed to remove Finder service",
	});
}
export async function takePendingVaultOpen(): Promise<string | null> {
	if (!isTauri()) return null;
	const result = await commands.vaultOpenTakePending();
	return result.ok ? (result.data ?? null) : null;
}
