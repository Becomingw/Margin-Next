import { createInstance, type TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en/agent.json";
import zh from "@/i18n/locales/zh-CN/agent.json";
import type { AgentPhaseState } from "@/lib/agent/api";
import type { AgentPart } from "@/lib/agent/chat-state";
import { streamingLabel } from "@/lib/agent/tool-activity";

/** Minimal typed t() stub: keys pass through so assertions stay literal. */
const t = ((key: string) => key) as unknown as TFunction<"agent", undefined>;

function phase(state: AgentPhaseState["phase"], detail?: string) {
	return { phase: state, detail };
}

const toolPart = (title: string, kind = "execute"): AgentPart => ({
	type: "tool",
	id: "p-tool",
	tool: { id: "t1", title, kind, status: "in_progress" },
});

describe("streamingLabel phase priority", () => {
	it("keeps provider reconnect details out of the status", () => {
		expect(streamingLabel(phase("reconnecting", "2/5"), [], t)).toBe(
			"streaming.reconnecting",
		);
	});

	it("drops blank reconnecting detail", () => {
		expect(streamingLabel(phase("reconnecting", "  "), [], t)).toBe(
			"streaming.reconnecting",
		);
		expect(streamingLabel(phase("reconnecting"), [], t)).toBe(
			"streaming.reconnecting",
		);
	});

	it("prefers phases over part-derived activity", () => {
		expect(streamingLabel(phase("waiting-model"), [toolPart("Read")], t)).toBe(
			"streaming.waitingModel",
		);
		expect(streamingLabel(phase("starting"), [toolPart("Read")], t)).toBe(
			"streaming.starting",
		);
	});

	it("prefers waiting-model over starting", () => {
		expect(streamingLabel(phase("waiting-model"), [], t)).toBe(
			"streaming.waitingModel",
		);
	});
});

describe("streamingLabel part fallbacks", () => {
	it("uses only the coarse activity, never the file name", () => {
		const parts: AgentPart[] = [
			{ type: "text", id: "p1", text: "intro" },
			{
				type: "tool",
				id: "p2",
				tool: {
					id: "t1",
					title: "Read file",
					kind: "read",
					status: "in_progress",
					locations: ["/vault/papers/x/NOTES.md"],
				},
			},
		];
		expect(streamingLabel(null, parts, t)).toBe("streaming.read");
	});

	it("says the answer is being written once text follows the tools", () => {
		const parts: AgentPart[] = [
			toolPart("terminal: earlier"),
			{ type: "text", id: "p1", text: "latest text" },
		];
		expect(streamingLabel(null, parts, t)).toBe("streaming.writing");
	});

	it("never surfaces raw reasoning text as the label", () => {
		const parts: AgentPart[] = [
			{ type: "reasoning", id: "p1", text: "considering options" },
		];
		expect(streamingLabel(null, parts, t)).toBe("streaming.thinking");
	});

	it("labels plan parts", () => {
		const parts: AgentPart[] = [
			{
				type: "plan",
				id: "p1",
				entries: [{ content: "step", status: "pending", priority: "medium" }],
			},
		];
		expect(streamingLabel(null, parts, t)).toBe("streaming.plan");
	});

	it("falls back to thinking for empty parts and no phase", () => {
		expect(streamingLabel(null, [], t)).toBe("streaming.thinking");
		expect(streamingLabel(undefined, [], t)).toBe("streaming.thinking");
	});
});

it("rotates localized copy without exposing commands, paths or provider details", async () => {
	const i18n = createInstance();
	await i18n.init({
		lng: "en",
		resources: { en: { agent: en }, "zh-CN": { agent: zh } },
	});
	for (const language of ["en", "zh-CN"]) {
		const translate = i18n.getFixedT(language, "agent");
		const part = toolPart("SECRET_TOOL command.exe --token=SECRET_TOKEN");
		if (part.type === "tool") {
			part.tool.input = { command: "command.exe --token=SECRET_TOKEN" };
			part.tool.locations = ["C:/SECRET_PATH/file.md"];
		}
		const variants = [0, 1, 2].map((n) =>
			streamingLabel(null, [part], translate, n),
		);
		expect(new Set(variants).size).toBe(3);
		for (const kind of [
			"read",
			"edit",
			"delete",
			"move",
			"search",
			"execute",
			"fetch",
			"think",
			"other",
			"unknown",
		]) {
			const status = streamingLabel(
				null,
				[toolPart("SECRET_TOOL", kind)],
				translate,
				1,
			);
			expect(status).not.toMatch(/SECRET|streaming\./);
		}
		expect(
			streamingLabel(
				phase("reconnecting", "SECRET_ENDPOINT"),
				[part],
				translate,
			),
		).not.toContain("SECRET");
		expect(variants.join(" ")).not.toMatch(/SECRET|command\.exe|streaming\./);
	}
});
