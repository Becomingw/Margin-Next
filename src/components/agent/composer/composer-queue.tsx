import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QueuedPrompt } from "@/components/agent/types";
import {
	Queue,
	QueueItem,
	QueueItemAction,
	QueueItemActions,
	QueueItemContent,
	QueueItemIndicator,
	QueueList,
	QueueSection,
	QueueSectionContent,
	QueueSectionLabel,
	QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { cn } from "@/lib/core/utils";

export function ComposerQueue({
	messageQueue,
	onRemoveQueuedMessage,
	compact = false,
}: {
	messageQueue: QueuedPrompt[];
	onRemoveQueuedMessage: (id: string) => void;
	compact?: boolean;
}) {
	const { t } = useTranslation("agent");
	if (messageQueue.length === 0) return null;
	return (
		<Queue
			className={cn(
				// A quiet strip above the input, not a second card.
				"shrink-0 gap-0 rounded-xl border-hairline-soft bg-card/60 px-1.5 py-1 shadow-none",
				compact && "py-0.5",
			)}
		>
			<QueueSection defaultOpen>
				<QueueSectionTrigger className="rounded-lg bg-transparent px-1.5 py-1 font-normal text-xs hover:bg-muted/60">
					<QueueSectionLabel
						count={messageQueue.length}
						label={t("composer.queueLabel")}
						className="gap-1.5 [&_svg]:size-3.5"
					/>
				</QueueSectionTrigger>
				<QueueSectionContent>
					<QueueList className="mt-0.5 -mb-0.5">
						{messageQueue.map((item) => {
							const imageCount = item.images?.length ?? 0;
							const queueLabel =
								item.text.trim() ||
								(item.visualDrafts.length
									? t("composer.visualAnnotationsTitle", {
											count: item.visualDrafts.length,
										})
									: imageCount > 0
										? t("composer.attachedImagesTitle", {
												count: imageCount,
											})
										: t("composer.visualAnnotation"));
							return (
								<QueueItem
									key={item.id}
									className={cn(
										"rounded-lg px-1.5 py-1",
										compact && "py-0.5 text-xs",
									)}
								>
									<div className="flex w-full items-center gap-2">
										<QueueItemIndicator />
										<QueueItemContent title={queueLabel}>
											{queueLabel}
										</QueueItemContent>
										<QueueItemActions>
											<QueueItemAction
												aria-label={t("composer.queueRemove")}
												title={t("composer.queueRemove")}
												onClick={() => onRemoveQueuedMessage(item.id)}
											>
												<X className="size-3.5" />
											</QueueItemAction>
										</QueueItemActions>
									</div>
								</QueueItem>
							);
						})}
					</QueueList>
				</QueueSectionContent>
			</QueueSection>
		</Queue>
	);
}
