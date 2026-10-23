import { MessageSquare, Quote, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/ai-elements/message";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import type { PdfAskThread } from "@/lib/pdf/ask/types";

/** Previously saved Ask marks remain readable; new questions go to the full Agent. */
export function LegacyAskCard({
	thread,
	screen,
	onQuote,
	onHide,
	onDelete,
	onPointerEnter,
	onPointerLeave,
}: {
	thread: PdfAskThread;
	screen: CardScreenPoint;
	onQuote: () => void;
	onHide: () => void;
	onDelete: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
}) {
	const { t } = useTranslation("viewer");
	return (
		<SelectionCard
			screen={screen}
			preferRight={screen.preferRight}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			title={t("annotations.sectionAsks")}
			icon={MessageSquare}
			width={360}
			actions={[
				{
					label: t("selection.askAgent"),
					onClick: onQuote,
					icon: <Quote />,
					disabled: !thread.anchor.quote?.trim(),
				},
				{
					label: t("annotations.delete"),
					onClick: onDelete,
					icon: <Trash2 />,
					destructive: true,
				},
				{ label: t("annotations.close"), onClick: onHide, icon: <X /> },
			]}
			bodyClassName="gap-3 p-3 text-sm"
		>
			{thread.anchor.quote ? (
				<blockquote className="border-l-2 pl-2 text-muted-foreground">
					{thread.anchor.quote}
				</blockquote>
			) : null}
			{thread.messages.map((message) => (
				<div
					key={message.id}
					className={message.role === "user" ? "font-medium" : ""}
				>
					<MessageResponse>{message.content}</MessageResponse>
				</div>
			))}
		</SelectionCard>
	);
}
