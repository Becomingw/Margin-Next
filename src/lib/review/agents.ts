/**
 * Several Agents can review one manuscript. Each gets its own color, taken
 * from the object-icon palette in the order Agents first wrote to this review,
 * so two Agents in one review never share a color and an Agent keeps its color
 * for the life of the review. Green and amber stay with the author's revisions
 * and comments; Agent writes from before names were recorded use the brand
 * color.
 */

import type { CSSProperties } from "react";
import type { ReviewComment } from "@/lib/core/bindings";

export const AGENT_HUES = [
	"violet",
	"blue",
	"teal",
	"rose",
	"slate",
	"copper",
] as const;

export type AgentHue = (typeof AGENT_HUES)[number];

export function agentHues(
	agents: readonly string[],
): ReadonlyMap<string, AgentHue> {
	return new Map(
		agents.map((name, i) => [name, AGENT_HUES[i % AGENT_HUES.length]]),
	);
}

/** CSS color for an Agent's marks; unnamed Agents use the brand. */
export function agentColor(hue: AgentHue | undefined): string {
	return hue ? `var(--icon-${hue})` : "var(--brand)";
}

/** Sets `--agent`, which review marks and cards color themselves with. */
export function agentStyle(hue: AgentHue | undefined): CSSProperties {
	return { "--agent": agentColor(hue) } as CSSProperties;
}

/** Comments an Agent wrote or replied to: its threads when focusing on it. */
export function agentCommentIds(
	comments: readonly ReviewComment[],
	agent: string,
): ReadonlySet<string> {
	return new Set(
		comments
			.filter(
				(c) =>
					c.agent === agent ||
					(c.replies ?? []).some((reply) => reply.agent === agent),
			)
			.map((c) => c.id),
	);
}
