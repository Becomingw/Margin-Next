/**
 * Kick catalog ACP soft-probe at app open so the Agent switcher is ready
 * before the lazy sidebar panel mounts.
 */
import { useEffect } from "react";
import { prefetchAgentCatalog } from "@/lib/agent/prefetch-catalog";

export function useAgentCatalogPrefetch(): void {
	useEffect(() => {
		prefetchAgentCatalog();
	}, []);
}
