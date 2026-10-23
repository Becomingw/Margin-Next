import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ComposerAttachImageButton } from "@/components/agent/composer/composer-attachments";
import {
	Context,
	ContextContent,
	ContextContentHeader,
	ContextTrigger,
} from "@/components/ai-elements/context";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";

/** Renders inside `PromptInputTools`; the attach-image button needs the PromptInput attachment context. */
export function ComposerToolbar({
	compact = false,
	switching,
	activeUsage,
	onOpenSkills,
}: {
	compact?: boolean;
	switching: boolean;
	activeUsage: { used: number; size: number } | null;
	/** Opens the `/` menu (skills + agent commands) without knowing the trigger. */
	onOpenSkills: () => void;
}) {
	const { t } = useTranslation("agent");
	return (
		<>
			{!compact && activeUsage && activeUsage.size > 0 ? (
				<Context usedTokens={activeUsage.used} maxTokens={activeUsage.size}>
					<ContextTrigger className="h-7 gap-1 px-1.5 font-normal text-xs" />
					<ContextContent>
						<ContextContentHeader />
					</ContextContent>
				</Context>
			) : null}
			{compact ? null : <ComposerAttachImageButton disabled={switching} />}
			{compact ? null : (
				<PromptInputButton
					type="button"
					className="size-7 text-foreground"
					disabled={switching}
					onClick={onOpenSkills}
					tooltip={t("composer.quick.skills")}
					aria-label={t("composer.quick.skills")}
				>
					<Sparkles className="size-3.5" />
				</PromptInputButton>
			)}
		</>
	);
}
