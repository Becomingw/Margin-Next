"use client";

/**
 * Ribbon entry for the Agents reviewing this manuscript: a color legend with
 * each Agent's open revisions and comments, a focus that shows one Agent's
 * work only, and previous/next through the focused items.
 */

import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/core/utils";
import { type AgentHue, agentStyle } from "@/lib/review/agents";
import { reviewStore } from "@/lib/review/store";

export type AgentStat = {
	/** null: Agent writes recorded before names were. */
	name: string | null;
	hue: AgentHue | undefined;
	changes: number;
	comments: number;
};

const ALL = "__all__";
const UNNAMED = "__unnamed__";

const navButton =
	"flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";

export function ReviewAgentMenu({
	agents,
	focus,
	ids,
	onFocus,
	onReveal,
	step,
}: {
	agents: readonly AgentStat[];
	focus: string | null;
	/** Items to step through: the focused Agent's, or every Agent's. */
	ids: readonly string[];
	onFocus: (agent: string | null) => void;
	onReveal: (id: string) => void;
	step: (
		ids: readonly string[],
		activeId: string | null,
		delta: number,
	) => string | undefined;
}) {
	const { t } = useTranslation("review");
	const activeId = useStore(reviewStore, (s) => s.activeCommentId);
	const focused = focus
		? agents.find((agent) => agent.name === focus)
		: undefined;
	const go = (delta: number) => {
		const next = step(ids, activeId, delta);
		if (next) onReveal(next);
	};
	const label = (agent: AgentStat) => agent.name ?? t("toolbar.unnamedAgent");
	return (
		<div className="inline-flex shrink-0 items-center gap-0.5">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title={t("toolbar.agentMenu")}
						aria-label={t("toolbar.agentMenu")}
						className={cn(
							"inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums transition-colors hover:bg-accent",
							focused ? "bg-accent text-(--agent)" : "text-brand",
						)}
						style={focused ? agentStyle(focused.hue) : undefined}
					>
						<Sparkles size={12} aria-hidden />
						{focused ? <span>{label(focused)}</span> : null}
						{ids.length}
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-56">
					<DropdownMenuLabel className="text-muted-foreground text-xs">
						{t("toolbar.agentMenu")}
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
					<DropdownMenuRadioGroup
						value={focus ?? ALL}
						onValueChange={(value) =>
							onFocus(value === ALL ? null : value === UNNAMED ? null : value)
						}
					>
						<DropdownMenuRadioItem value={ALL} className="text-xs">
							<Sparkles size={12} className="text-brand" aria-hidden />
							{t("toolbar.allAgents")}
						</DropdownMenuRadioItem>
						{agents.map((agent) => (
							<DropdownMenuRadioItem
								key={agent.name ?? UNNAMED}
								value={agent.name ?? UNNAMED}
								disabled={agent.name === null}
								className="text-xs"
								style={agentStyle(agent.hue)}
							>
								<span
									aria-hidden
									className="size-2.5 shrink-0 rounded-full bg-(--agent)"
								/>
								<span className="min-w-0 flex-1 truncate">{label(agent)}</span>
								<span className="shrink-0 text-muted-foreground tabular-nums">
									{t("toolbar.agentCounts", {
										changes: agent.changes,
										comments: agent.comments,
									})}
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<button
				type="button"
				disabled={!ids.length}
				title={t("toolbar.prevAgent")}
				aria-label={t("toolbar.prevAgent")}
				className={navButton}
				onClick={() => go(-1)}
			>
				<ChevronUp size={14} />
			</button>
			<button
				type="button"
				disabled={!ids.length}
				title={t("toolbar.nextAgent")}
				aria-label={t("toolbar.nextAgent")}
				className={navButton}
				onClick={() => go(1)}
			>
				<ChevronDown size={14} />
			</button>
		</div>
	);
}
