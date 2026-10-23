import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TurnWorkSummary } from "@/components/agent/turn-process";
import type { AgentPart } from "@/lib/agent/chat-state";

vi.mock("@/hooks/use-app-stores", () => ({
	useSettings: (selector: (state: { developerMode: boolean }) => unknown) =>
		selector({ developerMode: false }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}));

describe("Edda's normal process presentation", () => {
	it("does not mount technical payloads or reasoning even with saved expanded state", () => {
		const process: AgentPart[] = [
			{ type: "reasoning", id: "reason", text: "SECRET_REASONING" },
			{ type: "text", id: "narration", text: "SECRET_COMMAND" },
			{
				type: "tool",
				id: "tool",
				tool: {
					id: "tool",
					kind: "execute",
					title: "SECRET_TITLE",
					status: "failed",
					input: { command: "SECRET_INPUT" },
					output: "SECRET_OUTPUT",
				},
			},
		];
		const markup = renderToStaticMarkup(
			createElement(TurnWorkSummary, {
				rowKey: "row",
				process,
				durationMs: 2000,
				partOpenState: {
					"row:__process__": true,
					"row:reason": true,
					"row:tool": true,
				},
				onPartOpenChange: vi.fn(),
			}),
		);
		expect(markup).not.toContain("SECRET");
		expect(markup).toContain("activity.summary");
		expect(markup).toContain("activity.incomplete");
		expect(process).toHaveLength(3);
	});
});
