/**
 * Agent plugins = MCP servers from settings that every local agent session
 * receives. Users paste whatever an MCP server's README gives them: a bare
 * URL, a `{"mcpServers": {…}}` block (Claude Desktop / Cursor style), or a
 * single `{"name": {…}}` entry.
 */
import type { AgentMcpServer } from "@/lib/core/bindings";

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const stringMap = (value: unknown): Record<string, string> => {
	const record = asRecord(value);
	if (!record) return {};
	return Object.fromEntries(
		Object.entries(record).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
};

function serverFrom(name: string, value: unknown): AgentMcpServer | null {
	const config = asRecord(value);
	if (!config || !name.trim()) return null;
	const url =
		typeof config.url === "string"
			? config.url
			: typeof config.serverUrl === "string"
				? config.serverUrl
				: "";
	const command = typeof config.command === "string" ? config.command : "";
	if (!url.trim() && !command.trim()) return null;
	return {
		name: name.trim(),
		enabled: true,
		url: url.trim(),
		headers: stringMap(config.headers),
		command: command.trim(),
		args: Array.isArray(config.args)
			? config.args.filter((arg): arg is string => typeof arg === "string")
			: [],
		env: stringMap(config.env),
	};
}

/** A short, stable name for a URL-only server ("mcp.example.com" → "example"). */
function nameForUrl(url: URL): string {
	const parts = url.hostname.split(".").filter((part) => part !== "www");
	const core = parts.length > 1 ? parts[parts.length - 2] : parts[0];
	return core || url.hostname;
}

/** Parsed servers, or null when the text is neither a URL nor usable JSON. */
export function parseMcpServers(input: string): AgentMcpServer[] | null {
	const text = input.trim();
	if (!text) return null;
	if (/^https?:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			return [
				{
					name: nameForUrl(url),
					enabled: true,
					url: text,
					headers: {},
					command: "",
					args: [],
					env: {},
				},
			];
		} catch {
			return null;
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const root = asRecord(parsed);
	if (!root) return null;
	const entries = asRecord(root.mcpServers) ?? asRecord(root.servers) ?? root;
	const servers = Object.entries(entries)
		.map(([name, value]) => serverFrom(name, value))
		.filter((server): server is AgentMcpServer => server !== null);
	return servers.length ? servers : null;
}

/** Add or replace servers by name, keeping the existing order. */
export function mergeMcpServers(
	current: AgentMcpServer[],
	incoming: AgentMcpServer[],
): AgentMcpServer[] {
	const byName = new Map(incoming.map((server) => [server.name, server]));
	const merged = current.map((server) => byName.get(server.name) ?? server);
	const known = new Set(current.map((server) => server.name));
	return [...merged, ...incoming.filter((server) => !known.has(server.name))];
}

/** "example.com" for HTTP servers, the command line for local ones. */
export function mcpServerTarget(server: AgentMcpServer): string {
	if (server.url) {
		try {
			return new URL(server.url).host;
		} catch {
			return server.url;
		}
	}
	return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
}
