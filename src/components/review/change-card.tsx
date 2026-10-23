"use client";

import { Check, X } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { type AgentHue, agentStyle } from "@/lib/review/agents";
import type { TrackedChange } from "@/lib/review/anchor";
import { requestRevealAnchor } from "@/lib/review/store";

/** Only the selected revision gets a margin card: keep dense manuscripts quiet. */
export const ChangeCard = memo(function ChangeCard({
	change,
	hue,
	disabled,
	onAccept,
	onReject,
}: {
	change: TrackedChange;
	hue?: AgentHue;
	disabled: boolean;
	onAccept: (change: TrackedChange) => void;
	onReject: (change: TrackedChange) => void;
}) {
	const { t } = useTranslation("review");
	const label = t(
		`changes.${change.kind === "insert" ? "inserted" : change.kind === "delete" ? "deleted" : "replaced"}`,
	);
	return (
		<article
			className="rounded-lg border border-ring bg-card p-4 text-sm"
			data-review-comment-id={change.id}
			data-review-actor={change.actor === "agent" ? "agent" : "author"}
			style={agentStyle(hue)}
		>
			<div className="flex items-center justify-between gap-2 text-xs">
				<span
					className={
						change.actor === "agent"
							? "font-medium text-(--agent)"
							: "font-medium text-foreground"
					}
				>
					{change.actor === "agent"
						? (change.agentName ?? t("card.agent"))
						: t("card.author")}
				</span>
				<span className="text-muted-foreground">{label}</span>
			</div>
			<button
				type="button"
				className="mt-3 block max-h-40 w-full overflow-y-auto whitespace-pre-wrap break-words text-left leading-relaxed"
				onClick={() => requestRevealAnchor(change.id)}
				title={t("toolbar.nextItem")}
			>
				{change.before ? (
					<del className="review-change-delete">{change.before}</del>
				) : null}
				{change.before && change.after ? " " : null}
				{change.after ? (
					<ins className="review-change-insert">{change.after}</ins>
				) : null}
			</button>
			<div className="mt-4 flex flex-wrap gap-2">
				<button
					type="button"
					className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-40"
					disabled={disabled}
					onClick={() => onAccept(change)}
					title={t("toolbar.acceptChange")}
				>
					<Check size={14} aria-hidden />
					{t("changes.accept")}
				</button>
				<button
					type="button"
					className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
					disabled={disabled}
					onClick={() => onReject(change)}
					title={t("toolbar.rejectChange")}
				>
					<X size={14} aria-hidden />
					{t("changes.reject")}
				</button>
			</div>
		</article>
	);
});
