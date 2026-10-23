import { MapPin, Quote, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openSelectionReference } from "@/lib/agent/reference-navigation";
import {
	referencePageLabel,
	type SelectionContext,
} from "@/lib/agent/selection-reference";
import { basenameOf } from "@/lib/core/path";

export function ChatReferences({
	references,
	expanded = false,
	onRemove,
}: {
	references: SelectionContext[];
	expanded?: boolean;
	onRemove?: (id: string) => void;
}) {
	const { t } = useTranslation("agent");
	return (
		<div className="mb-2 ml-auto flex max-w-full flex-col gap-1.5">
			{references.map((reference) => (
				<details
					key={reference.id}
					open={expanded || undefined}
					className="max-h-60 overflow-auto rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs"
				>
					<summary className="flex cursor-default items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
						<Quote className="size-3 shrink-0" aria-hidden />
						<span className="max-w-28 shrink-0 truncate text-muted-foreground">
							{basenameOf(reference.sourcePath)}
							{reference.page ? ` · ${referencePageLabel(reference)}` : ""}
						</span>
						<span className="min-w-0 truncate">
							{reference.text.slice(0, 90)}
						</span>
						{onRemove ? (
							<button
								type="button"
								className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
								aria-label={t("composer.removeSelection")}
								onClick={(event) => {
									event.preventDefault();
									onRemove(reference.id);
								}}
							>
								<X className="size-3" />
							</button>
						) : null}
					</summary>
					<blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-primary/30 pl-2 leading-relaxed">
						{reference.text}
					</blockquote>
					{reference.truncated ? (
						<p className="mt-1 text-muted-foreground">
							{t("references.truncated")}
						</p>
					) : null}
					<button
						type="button"
						className="mt-2 inline-flex max-w-full items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						onClick={() => openSelectionReference(reference)}
						aria-label={t("references.openSource")}
					>
						<MapPin className="size-3 shrink-0" aria-hidden />
						<span className="truncate">
							{basenameOf(reference.sourcePath)}
							{reference.page
								? ` · ${t("references.page", { page: referencePageLabel(reference) })}`
								: ""}
						</span>
					</button>
				</details>
			))}
		</div>
	);
}
