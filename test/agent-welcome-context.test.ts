import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { agentWelcomeTitle } from "@/lib/agent/welcome-context";

const previousLanguage = i18n.language;
beforeAll(async () => {
	await i18n.changeLanguage("en");
});
afterAll(async () => {
	await i18n.changeLanguage(previousLanguage);
});

describe("Agent welcome conversation ownership", () => {
	it("uses the full paper title rather than an author-suffixed tree label or directory id", () => {
		const paperMeta = new Map([
			["papers/example", { title: "Current catalog title" }],
		]);
		expect(
			agentWelcomeTitle({
				scope: "paper:papers/example",
				paperTitle: "Older tab title",
				paperMeta,
			}),
		).toBe("Current catalog title");
		expect(
			agentWelcomeTitle({
				scope: "paper:papers/other",
				paperTitle: "  Focused paper  ",
			}),
		).toBe("Focused paper");
		expect(agentWelcomeTitle({ scope: "paper:papers/example" })).toBe(
			"example",
		);
	});
	it("never leaks the previous paper title into Library or Plaza conversations", () => {
		const paperTitle = "Previous paper";
		expect(agentWelcomeTitle({ scope: "page:edda:library", paperTitle })).toBe(
			"Library",
		);
		expect(
			agentWelcomeTitle({
				scope: "page:edda:plaza/paper-pool",
				paperTitle,
			}),
		).toBe("Paper pool");
		expect(
			agentWelcomeTitle({ scope: "page:edda:plaza/feeds", paperTitle }),
		).toBe("Paper pool");
		expect(
			agentWelcomeTitle({
				scope: "page:edda:plaza/cool-papers",
				paperTitle,
			}),
		).toBe("Cool Papers");
		expect(agentWelcomeTitle({ scope: "page:edda:trash", paperTitle })).toBe(
			"Recycle Bin",
		);
	});
	it("handles notes, Windows separators and a workspace without a Vault", () => {
		expect(agentWelcomeTitle({ scope: "page:notes\\Research.md" })).toBe(
			"Research.md",
		);
		expect(agentWelcomeTitle({ hasVault: false })).toBe("Workspace");
		expect(agentWelcomeTitle({ scope: "page:edda:unknown" })).toBe("Workspace");
	});
});
