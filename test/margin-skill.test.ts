import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Margin external review skill", () => {
	it("documents exactly the tools exposed by the independent MCP router", () => {
		const skill = readFileSync("skills/margin-mcp-reviewer/SKILL.md", "utf8");
		const server = readFileSync("src-tauri/src/margin/ai/tools.rs", "utf8");
		const actual = new Set(
			[...server.matchAll(/async fn (review_\w+)\(/g)].map((m) => m[1]),
		);
		const documented = new Set(
			[...skill.matchAll(/`(review_\w+)`/g)].map((m) => m[1]),
		);
		expect(documented).toEqual(actual);
		expect(actual.size).toBe(7);
	});
});
