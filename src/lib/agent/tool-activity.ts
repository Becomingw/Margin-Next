/**
 * Plain-language view of an agent turn's work: what each tool call does
 * ("Read NOTES.md"), how a run of calls reads as one step ("Read 5 files"),
 * and which parts are process versus the final answer.
 */
import type { TFunction } from "i18next";
import type { AgentPhaseState } from "@/lib/agent/api";
import type { AgentPart, ToolUiState } from "@/lib/agent/chat-state";

/** Coarse action buckets; ACP `ToolKind`s map onto these. */
export type ToolCategory =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "fetch"
	| "think"
	| "other";

const CATEGORY_BY_KIND: Record<string, ToolCategory> = {
	read: "read",
	edit: "edit",
	delete: "delete",
	move: "move",
	search: "search",
	execute: "execute",
	fetch: "fetch",
	think: "think",
};

export function toolCategory(tool: Pick<ToolUiState, "kind">): ToolCategory {
	return CATEGORY_BY_KIND[tool.kind] ?? "other";
}

const basename = (path: string) =>
	path
		.replace(/[\\/]+$/, "")
		.split(/[\\/]/)
		.pop() || path;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const firstString = (
	record: Record<string, unknown> | null,
	keys: string[],
): string | null => {
	if (!record) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (Array.isArray(value) && typeof value[0] === "string") {
			return value.join(" ").trim() || null;
		}
	}
	return null;
};

const clip = (text: string, max = 48) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Full paths a file tool touches: ACP locations, else the path in its input. */
export function toolFilePaths(tool: ToolUiState): string[] {
	if (tool.locations?.length) return tool.locations;
	const path = firstString(asRecord(tool.input), [
		"file_path",
		"filePath",
		"path",
		"notebook_path",
		"filename",
	]);
	return path ? [path] : [];
}

const fileTarget = (tool: ToolUiState) => {
	const path = toolFilePaths(tool)[0];
	return path ? basename(path) : null;
};

/**
 * Files a turn wrote, in first-write order: completed edits and move
 * targets, minus anything a later call deleted. Commands that write files
 * as a side effect are not visible here.
 */
export function producedFiles(parts: AgentPart[]): string[] {
	const files: string[] = [];
	const add = (path: string | undefined) => {
		if (path && !files.includes(path)) files.push(path);
	};
	for (const part of parts) {
		if (part.type !== "tool" || part.tool.status !== "completed") continue;
		const paths = toolFilePaths(part.tool);
		switch (toolCategory(part.tool)) {
			case "edit":
				paths.forEach(add);
				break;
			case "move":
				for (const moved of paths.slice(0, -1)) {
					if (files.includes(moved)) files.splice(files.indexOf(moved), 1);
				}
				add(paths[paths.length - 1]);
				break;
			case "delete":
				for (const gone of paths) {
					if (files.includes(gone)) files.splice(files.indexOf(gone), 1);
				}
				break;
		}
	}
	return files;
}

/**
 * The short object of a call — a file name, query, command or host. File
 * tools use ACP locations first; commands and searches use their own text,
 * since agents often report the working directory as a location.
 */
export function toolTarget(tool: ToolUiState): string | null {
	const input = asRecord(tool.input);
	switch (toolCategory(tool)) {
		case "execute": {
			const command = firstString(input, ["command", "cmd", "script"]);
			// Skip a leading `cd <dir> &&` so the label shows the real command.
			const line = command?.split("\n")[0]?.replace(/^cd\s+\S+\s*&&\s*/, "");
			return line ? clip(line) : null;
		}
		case "search": {
			const query = firstString(input, [
				"query",
				"pattern",
				"q",
				"search",
				"regex",
			]);
			return query ? clip(query) : fileTarget(tool);
		}
		case "fetch": {
			const url = firstString(input, ["url", "uri"]);
			if (!url) return null;
			try {
				return new URL(url).host || clip(url);
			} catch {
				return clip(url);
			}
		}
		default:
			return fileTarget(tool);
	}
}

type ActivityT = TFunction<"agent", undefined>;

/** One call as a phrase: "Read NOTES.md", "Search attention", or its own title. */
export function describeTool(tool: ToolUiState, t: ActivityT): string {
	const category = toolCategory(tool);
	if (category === "other") {
		return tool.title.trim() || t("activity.verb.other");
	}
	const target = toolTarget(tool);
	return target
		? t(`activity.one.${category}`, { target })
		: tool.title.trim() || t(`activity.verb.${category}`);
}

/** A run of same-category calls as one phrase: "Read 5 files". */
export function describeToolRun(tools: ToolUiState[], t: ActivityT): string {
	const first = tools[0];
	if (!first) return "";
	if (tools.length === 1) return describeTool(first, t);
	return t(`activity.many.${toolCategory(first)}`, { count: tools.length });
}

/** "Read 5 files · Searched 2 times · Edited 1 file" for the whole turn. */
export function summarizeTools(tools: ToolUiState[], t: ActivityT): string {
	const counts = new Map<ToolCategory, number>();
	for (const tool of tools) {
		const category = toolCategory(tool);
		if (category === "think") continue;
		counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	return [...counts]
		.map(([category, count]) => t(`activity.many.${category}`, { count }))
		.join(" · ");
}

export type ProcessItem =
	| { type: "tools"; key: string; tools: ToolUiState[] }
	| { type: "part"; part: Exclude<AgentPart, { type: "tool" }> };

/** Process parts in order, with consecutive same-category tool calls merged. */
export function groupProcessParts(parts: AgentPart[]): ProcessItem[] {
	const items: ProcessItem[] = [];
	for (const part of parts) {
		if (part.type !== "tool") {
			items.push({ type: "part", part });
			continue;
		}
		const last = items[items.length - 1];
		if (
			last?.type === "tools" &&
			toolCategory(last.tools[0] as ToolUiState) === toolCategory(part.tool)
		) {
			last.tools.push(part.tool);
		} else {
			items.push({ type: "tools", key: part.id, tools: [part.tool] });
		}
	}
	return items;
}

/**
 * Split a turn into process (reasoning, tools, plan and the narration
 * between them) and answer (text after the last tool / plan). While the turn
 * streams, only that trailing text is the live answer. Once it is done and
 * ended on a tool (no trailing text), every text part stays in the answer
 * rather than hiding the reply.
 */
export function splitTurn(
	parts: AgentPart[],
	{ streaming = false }: { streaming?: boolean } = {},
): { process: AgentPart[]; answer: AgentPart[] } {
	let lastWork = -1;
	parts.forEach((part, index) => {
		if (part.type === "tool" || part.type === "plan") lastWork = index;
	});
	const trailingText = parts
		.slice(lastWork + 1)
		.some((part) => part.type === "text" && part.text.trim());
	if (lastWork < 0 || (!streaming && !trailingText)) {
		return {
			process: parts.filter((part) => part.type !== "text"),
			answer: parts.filter((part) => part.type === "text"),
		};
	}
	return {
		process: parts.filter(
			(part, index) => index <= lastWork || part.type !== "text",
		),
		answer: parts.filter(
			(part, index) => index > lastWork && part.type === "text",
		),
	};
}

/** "42 s" / "3 min 05 s" style turn duration. */
export function formatDuration(ms: number, t: ActivityT): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return t("activity.seconds", { count: seconds });
	return t("activity.minutes", {
		minutes: Math.floor(seconds / 60),
		seconds: String(seconds % 60).padStart(2, "0"),
	});
}

/**
 * Presentation-only status: never interpolate provider titles, phase details,
 * commands, paths or payloads. Slow variants add warmth without inventing progress.
 */
export function streamingLabel(
	phase: AgentPhaseState | null | undefined,
	parts: AgentPart[],
	t: TFunction<"agent", undefined>,
	variation = 0,
): string {
	const context = [undefined, "alternate", "third"][
		Math.abs(Math.floor(variation)) % 3
	];
	if (phase?.phase === "reconnecting") return t("streaming.reconnecting");
	if (phase?.phase === "waiting-model")
		return t("streaming.waitingModel", { context });
	if (phase?.phase === "starting") return t("streaming.starting", { context });

	const last = parts[parts.length - 1];
	if (last?.type === "text" && last.text.trim())
		return t("streaming.writing", { context });
	if (last?.type === "tool")
		return t(`streaming.${toolCategory(last.tool)}`, { context });
	if (last?.type === "plan") return t("streaming.plan", { context });
	return t("streaming.thinking", { context });
}
