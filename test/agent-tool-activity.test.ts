import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { AgentPart, ToolUiState } from "@/lib/agent/chat-state";
import {
	describeTool,
	groupProcessParts,
	producedFiles,
	splitTurn,
	summarizeTools,
	toolTarget,
} from "@/lib/agent/tool-activity";

/** Echo the key plus its interpolation so assertions stay literal. */
const t = ((key: string, options?: Record<string, unknown>) =>
	options
		? `${key}(${String(options.target ?? options.count ?? "")})`
		: key) as unknown as TFunction<"agent", undefined>;

const tool = (
	id: string,
	kind: string,
	extra: Partial<ToolUiState> = {},
): ToolUiState => ({ id, title: "", kind, status: "completed", ...extra });

const toolPart = (value: ToolUiState): AgentPart => ({
	type: "tool",
	id: `p-${value.id}`,
	tool: value,
});
const text = (id: string, value: string): AgentPart => ({
	type: "text",
	id,
	text: value,
});

describe("toolTarget", () => {
	it("prefers ACP locations, then common raw-input fields", () => {
		expect(
			toolTarget(tool("a", "read", { locations: ["/v/p/NOTES.md"] })),
		).toBe("NOTES.md");
		expect(
			toolTarget(tool("b", "edit", { input: { file_path: "C:\\v\\a.tex" } })),
		).toBe("a.tex");
		expect(
			toolTarget(tool("c", "search", { input: { pattern: "attn" } })),
		).toBe("attn");
		expect(
			toolTarget(
				tool("d", "fetch", { input: { url: "https://arxiv.org/abs/1" } }),
			),
		).toBe("arxiv.org");
	});

	it("labels commands by their text, not the working directory", () => {
		expect(
			toolTarget(
				tool("g", "execute", {
					locations: ["/Users/me/vault"],
					input: {
						command: "cd /tmp && ls papers/1706",
						workdir: "/Users/me/vault",
					},
				}),
			),
		).toBe("ls papers/1706");
	});

	it("falls back to the tool title when nothing identifies the target", () => {
		expect(describeTool(tool("e", "execute", { title: "Bash" }), t)).toBe(
			"Bash",
		);
		expect(
			describeTool(tool("f", "other", { title: "mcp__edda__list" }), t),
		).toBe("mcp__edda__list");
	});
});

describe("groupProcessParts / summarizeTools", () => {
	it("merges consecutive calls of the same kind only", () => {
		const parts = [
			toolPart(tool("1", "read")),
			toolPart(tool("2", "read")),
			text("n", "narration"),
			toolPart(tool("3", "read")),
			toolPart(tool("4", "search")),
		];
		const items = groupProcessParts(parts);
		expect(
			items.map((item) => (item.type === "tools" ? item.tools.length : "part")),
		).toEqual([2, "part", 1, 1]);
		expect(
			summarizeTools(
				parts.flatMap((p) => (p.type === "tool" ? [p.tool] : [])),
				t,
			),
		).toBe("activity.many.read(3) · activity.many.search(1)");
	});
});

describe("splitTurn", () => {
	it("keeps narration in the process and the trailing text as the answer", () => {
		const parts = [
			text("a", "Let me read it."),
			toolPart(tool("1", "read")),
			text("b", "The answer."),
		];
		const { process, answer } = splitTurn(parts);
		expect(answer.map((p) => p.id)).toEqual(["b"]);
		expect(process.map((p) => p.id)).toEqual(["a", "p-1"]);
	});

	it("shows every text part when a finished turn ends on a tool", () => {
		const parts = [text("a", "Summary first."), toolPart(tool("1", "edit"))];
		expect(splitTurn(parts).answer.map((p) => p.id)).toEqual(["a"]);
		// …but while streaming only text after the latest tool is live.
		expect(splitTurn(parts, { streaming: true }).answer).toEqual([]);
	});
});

describe("producedFiles", () => {
	it("lists completed writes once, follows moves and drops deleted files", () => {
		const parts = [
			toolPart(tool("r", "read", { locations: ["/v/papers/a/NOTES.md"] })),
			toolPart(
				tool("w1", "edit", { input: { file_path: "/v/notes/report.html" } }),
			),
			toolPart(
				tool("w2", "edit", {
					locations: ["/v/notes/report.html", "/v/notes/style.css"],
				}),
			),
			toolPart(tool("w3", "edit", { locations: ["/v/notes/draft.md"] })),
			toolPart(
				tool("mv", "move", {
					locations: ["/v/notes/draft.md", "/v/notes/final.md"],
				}),
			),
			toolPart(tool("tmp", "edit", { locations: ["/v/tmp.txt"] })),
			toolPart(tool("rm", "delete", { locations: ["/v/tmp.txt"] })),
			toolPart(
				tool("failed", "edit", { status: "failed", locations: ["/v/x.md"] }),
			),
		];
		expect(producedFiles(parts)).toEqual([
			"/v/notes/report.html",
			"/v/notes/style.css",
			"/v/notes/final.md",
		]);
	});
});
