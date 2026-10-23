import i18n from "@/i18n";
import { contextPathDisplayName } from "@/lib/agent/context-path-icon";
import { MANAGEMENT_SCOPE } from "@/lib/agent/conversation-history";
import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import {
	normalizePlazaPath,
	plazaSourceForPath,
	plazaSourceLabel,
} from "@/lib/plaza/sources";

/** Display the conversation's page ownership, not its temporary attachments. */
export function agentWelcomeTitle({
	scope = MANAGEMENT_SCOPE,
	paperTitle,
	paperMeta,
	hasVault = true,
}: {
	scope?: string;
	paperTitle?: string | null;
	paperMeta?: ReadonlyMap<string, { title?: string }> | null;
	hasVault?: boolean;
}): string {
	if (scope.startsWith("paper:")) {
		const path = scope.slice("paper:".length).replace(/\\/g, "/");
		return (
			paperMeta?.get(path)?.title?.trim() ||
			paperTitle?.trim() ||
			contextPathDisplayName(path)
		);
	}
	const path = scope.startsWith("page:") ? scope.slice("page:".length) : "";
	if (!path || isLibraryVirtualPath(path)) {
		return hasVault
			? i18n.t("sidebar:papersLibrary.title")
			: i18n.t("agent:empty.workspace");
	}
	if (isTrashVirtualPath(path)) return i18n.t("sidebar:recycleBin.title");
	const source = plazaSourceForPath(normalizePlazaPath(path));
	if (source) return plazaSourceLabel(source);
	return path.startsWith(`${VIRTUAL_PATH_PREFIX}`)
		? i18n.t("agent:empty.workspace")
		: contextPathDisplayName(path);
}
