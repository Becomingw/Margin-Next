import { describe, expect, it } from "vitest";
import {
	mcpServerTarget,
	mergeMcpServers,
	parseMcpServers,
} from "@/lib/agent/mcp-plugins";

describe("parseMcpServers", () => {
	it("reads a Claude Desktop style mcpServers block", () => {
		const servers = parseMcpServers(
			JSON.stringify({
				mcpServers: {
					fs: {
						command: "npx",
						args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
						env: { DEBUG: "1", IGNORED: 2 },
					},
					docs: {
						url: "https://mcp.example.com/mcp",
						headers: { "X-Key": "k" },
					},
					broken: { note: "no target" },
				},
			}),
		);
		expect(servers?.map((s) => s.name)).toEqual(["fs", "docs"]);
		expect(servers?.[0]?.env).toEqual({ DEBUG: "1" });
		expect(servers?.[1]?.headers).toEqual({ "X-Key": "k" });
	});

	it("accepts a bare URL and a single named entry", () => {
		expect(parseMcpServers("https://mcp.context7.com/mcp")?.[0]).toMatchObject({
			name: "context7",
			url: "https://mcp.context7.com/mcp",
		});
		expect(
			parseMcpServers(
				'{"search": {"command": "uvx", "args": ["mcp-search"]}}',
			)?.[0]?.name,
		).toBe("search");
	});

	it("rejects text that is neither", () => {
		expect(parseMcpServers("not json")).toBeNull();
		expect(parseMcpServers('{"a": 1}')).toBeNull();
	});
});

describe("mergeMcpServers / mcpServerTarget", () => {
	it("replaces by name in place and appends new ones", () => {
		const base =
			parseMcpServers('{"a":{"command":"x"},"b":{"command":"y"}}') ?? [];
		const next = mergeMcpServers(
			base,
			parseMcpServers(
				'{"b":{"command":"z"},"c":{"url":"https://c.dev/mcp"}}',
			) ?? [],
		);
		expect(next.map((s) => `${s.name}:${mcpServerTarget(s)}`)).toEqual([
			"a:x",
			"b:z",
			"c:c.dev",
		]);
	});
});
