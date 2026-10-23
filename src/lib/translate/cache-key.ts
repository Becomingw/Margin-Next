import type { TranslateSettings } from "@/lib/translate/types";

/** Translation output identity; credentials must never enter Vault caches. */
export function translateServiceKey(settings: TranslateSettings): string {
	const providerId = settings.provider;
	if (providerId === "agent") {
		return `agent:${settings.agentId || "default"}:${settings.modelId || "default"}`;
	}
	const config = Object.entries(settings.providerConfigs).find(
		([id]) => id === providerId,
	)?.[1];
	if (!config) return providerId;
	return [
		providerId,
		config.baseUrl?.trim() ?? "",
		config.region?.trim() ?? "",
		config.model?.trim() ?? "",
	].join(":");
}
