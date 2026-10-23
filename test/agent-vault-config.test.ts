import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	readAgentInstructions,
	saveAgentInstructions,
} from "@/lib/agent/vault-config";
import { commands, type InstructionsFile } from "@/lib/core/bindings";
import { agentConfigurationPage } from "@/lib/vault/agent-config-paths";

vi.mock("@/lib/core/bindings", () => ({
	commands: {
		agentVaultInstructions: vi.fn(),
		agentSaveVaultInstructions: vi.fn(),
	},
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

describe("Agent instruction saves", () => {
	const original: InstructionsFile = {
		content: "old",
		defaultContent: "default",
		revision: "revision-1",
	};
	beforeEach(() => vi.clearAllMocks());

	it("does not write without the second confirmation", async () => {
		await expect(
			saveAgentInstructions("/vault", "draft", original, false),
		).rejects.toThrow();
		expect(commands.agentSaveVaultInstructions).not.toHaveBeenCalled();
	});

	it("reads without creating a file and sends the original revision only when confirmed", async () => {
		vi.mocked(commands.agentVaultInstructions).mockResolvedValue({
			ok: true,
			data: original,
			error: null,
		});
		const file = await readAgentInstructions("/vault");
		expect(commands.agentSaveVaultInstructions).not.toHaveBeenCalled();
		vi.mocked(commands.agentSaveVaultInstructions).mockResolvedValue({
			ok: true,
			data: { ...original, content: "draft", revision: "revision-2" },
			error: null,
		});
		await saveAgentInstructions("/vault", "draft", file, true);
		expect(commands.agentSaveVaultInstructions).toHaveBeenCalledWith(
			"/vault",
			"draft",
			"revision-1",
			true,
		);
	});

	it("does not retry a conflict by overwriting the external edit", async () => {
		vi.mocked(commands.agentSaveVaultInstructions).mockResolvedValue({
			ok: false,
			data: null,
			error: { code: "agent_config_conflict", message: "changed" },
		});
		await expect(
			saveAgentInstructions("/vault", "draft", original, true),
		).rejects.toThrow();
		expect(commands.agentSaveVaultInstructions).toHaveBeenCalledTimes(1);
	});

	it("routes filesystem configuration paths without intercepting remote web documents", () => {
		expect(agentConfigurationPage("C:\\vault\\AGENTS.md")).toBe("instructions");
		expect(
			agentConfigurationPage("remote:session/.agents/skills/custom/SKILL.md"),
		).toBe("skills");
		expect(agentConfigurationPage("https://example.org/AGENTS.md")).toBeNull();
		expect(agentConfigurationPage("/vault/notes/Agents.md")).toBeNull();
	});
});
