import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
export const SKILL_MANAGEMENT_PATH = `${VIRTUAL_PATH_PREFIX}plaza/skills`;

/** Configuration has dedicated editors; keep ordinary document writes separate. */
export function agentConfigurationPage(
	path: string,
): "skills" | "instructions" | null {
	if (/^(?:https?|data|blob):/i.test(path)) return null;
	const parts = path.replace(/\\/g, "/").split("/");
	if (parts.includes(".agents")) return "skills";
	return parts.at(-1) === "AGENTS.md" ? "instructions" : null;
}
