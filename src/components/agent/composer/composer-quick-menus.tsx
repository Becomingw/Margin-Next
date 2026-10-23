import { Settings2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PopoverContent } from "@/components/ui/popover";
import type { AgentSkill } from "@/lib/agent";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import { cn } from "@/lib/core/utils";

export function cleanSkillDisplayName(name: string): string {
	return name
		.trim()
		.replace(/^[/$]+/, "")
		.replace(/^skill\s*:\s*/i, "");
}

/** One row of the `/` · `$` menu: an Edda skill, an agent command, or "Manage skills". */
export type QuickOption =
	| { kind: "skill"; skill: AgentSkill }
	| { kind: "command"; command: AcpCommand }
	| { kind: "manage" };

export function quickOptionKey(option: QuickOption): string {
	return option.kind === "skill"
		? `skill:${option.skill.id}`
		: option.kind === "command"
			? `command:${option.command.id}`
			: "manage";
}

/**
 * Skills and the agent's own commands in one list (skills first), ending with
 * a shortcut to skill management. Must render inside the composer `Popover`
 * subtree — `PopoverContent` needs its context.
 */
export function ComposerQuickMenu({
	options,
	activeIndex,
	onPick,
	onActiveIndexChange,
}: {
	options: QuickOption[];
	activeIndex: number;
	onPick: (option: QuickOption) => void;
	onActiveIndexChange: (index: number) => void;
}) {
	const { t } = useTranslation("agent");
	const hasSkills = options.some((option) => option.kind === "skill");
	const hasCommands = options.some((option) => option.kind === "command");
	return (
		<PopoverContent
			id="agent-quick-menu"
			role="listbox"
			side="top"
			align="start"
			sideOffset={8}
			onOpenAutoFocus={(event) => event.preventDefault()}
			// Match the composer width so the menu never spills past the panel.
			className="max-h-(--radix-popover-content-available-height) w-(--radix-popover-trigger-width) gap-0 overflow-y-auto rounded-xl p-1"
		>
			{options.map((option, index) => {
				const previous = options[index - 1];
				const heading =
					hasSkills && hasCommands && option.kind !== previous?.kind
						? option.kind === "skill"
							? t("composer.quick.skills")
							: option.kind === "command"
								? t("composer.quick.commands")
								: null
						: null;
				return (
					<div key={quickOptionKey(option)}>
						{option.kind === "manage" && index > 0 ? (
							<div className="my-1 h-px bg-hairline-soft" aria-hidden />
						) : null}
						{heading ? (
							<p className="px-2 pt-1.5 pb-0.5 text-caption text-muted-foreground">
								{heading}
							</p>
						) : null}
						<button
							id={`agent-quick-option-${index}`}
							type="button"
							role="option"
							aria-selected={activeIndex === index}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none",
								activeIndex === index ? "bg-muted" : "hover:bg-muted/70",
								option.kind === "manage" && "text-muted-foreground",
							)}
							onMouseEnter={() => onActiveIndexChange(index)}
							onClick={() => onPick(option)}
						>
							{option.kind === "skill" ? (
								<>
									<Sparkles
										className="size-3.5 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<span className="min-w-0 flex-1 truncate">
										{cleanSkillDisplayName(option.skill.name)}
									</span>
									{option.skill.description ? (
										<span className="max-w-40 truncate text-muted-foreground text-xs">
											{option.skill.description}
										</span>
									) : null}
								</>
							) : option.kind === "command" ? (
								<>
									<span className="flex min-w-0 flex-1 items-center truncate">
										<span className="shrink-0 font-mono text-muted-foreground">
											/
										</span>
										<span className="shrink-0 whitespace-nowrap">
											{option.command.title}
										</span>
									</span>
									{option.command.description ? (
										<span className="min-w-0 max-w-40 flex-1 truncate text-muted-foreground text-xs">
											{option.command.description}
										</span>
									) : null}
								</>
							) : (
								<>
									<Settings2 className="size-3.5 shrink-0" aria-hidden />
									<span className="min-w-0 flex-1 truncate text-xs">
										{t("composer.quick.manage")}
									</span>
								</>
							)}
						</button>
					</div>
				);
			})}
		</PopoverContent>
	);
}
