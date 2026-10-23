import i18n from "@/i18n";
import { commands, type InstructionsFile } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { isPathMissingError } from "@/lib/vault/tree";
import defaultInstructions from "../../../templates/vault/AGENTS.md?raw";

export async function readAgentInstructions(
	vault: string,
): Promise<InstructionsFile> {
	if (!isRemoteVaultHandle(vault))
		return callApi(() => commands.agentVaultInstructions(vault));
	const defaults: InstructionsFile = {
		content: defaultInstructions,
		defaultContent: defaultInstructions,
		revision: null,
	};
	try {
		const content = await readVaultFile(joinVaultPath(vault, "AGENTS.md"));
		return { ...defaults, content, revision: `remote:${content}` };
	} catch (error) {
		if (isPathMissingError(error)) return defaults;
		throw error;
	}
}

export async function saveAgentInstructions(
	vault: string,
	content: string,
	original: InstructionsFile,
	confirmed: boolean,
): Promise<InstructionsFile> {
	if (!confirmed)
		throw new Error(i18n.t("settings:agent.instructions.confirmRequired"));
	if (!isRemoteVaultHandle(vault))
		return callApi(async () => {
			const result = await commands.agentSaveVaultInstructions(
				vault,
				content,
				original.revision,
				true,
			);
			if (!result.ok && result.error?.code === "agent_config_conflict")
				throw new Error(i18n.t("settings:agent.instructions.conflict"));
			return result;
		});
	const current = await readAgentInstructions(vault);
	if (current.revision !== original.revision)
		throw new Error(i18n.t("settings:agent.instructions.conflict"));
	await writeVaultFile(joinVaultPath(vault, "AGENTS.md"), content, {
		agentConfigurationConfirmed: true,
	});
	return { ...original, content, revision: `remote:${content}` };
}
