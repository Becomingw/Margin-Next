import {
	Languages,
	MinusIcon,
	Pin,
	PinOff,
	Settings2Icon,
	StickyNote,
	Trash2Icon,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { SelectionCard } from "@/components/viewer/pdf/cards/selection-card";
import type { FloatingCardFrame } from "@/components/viewer/pdf/cards/use-floating-card";
import type { ScreenPoint } from "@/components/viewer/pdf/types";

type TranslateCardProps = {
	screen: ScreenPoint;
	preferRight?: boolean;
	/** Translation text (may stream in) */
	result: string;
	streaming: boolean;
	error: string | null;
	/** Open Translate settings from an API failure state. */
	onOpenSettings: () => void;
	/** Hide card; pin remains for reopen */
	onHide: () => void;
	/** Delete persisted translate record + pin */
	onDelete: () => void;
	onPointerEnter?: () => void;
	onPointerLeave?: () => void;
	pinned?: boolean;
	onPinnedChange?: (pinned: boolean) => void;
	onConvertToNote?: () => void;
	converting?: boolean;
	/**
	 * Pinned position owned by the caller (kept relative to the source text).
	 * Together with `anchored`, the card scrolls with its content.
	 */
	frame?: FloatingCardFrame | null;
	onFrameChange?: (frame: FloatingCardFrame) => void;
	anchored?: boolean;
	/** Open above the source text (chosen once, when the card opened). */
	openUp?: boolean;
	/** Horizontal room of the area the card is clipped to. */
	bounds?: { left: number; width: number } | null;
};

/**
 * Temporary translation result. Pinning is a reading-session UI preference;
 * only explicit conversion creates a persisted annotation.
 */
export function TranslateCard({
	screen,
	preferRight = false,
	result,
	streaming,
	error,
	onOpenSettings,
	onHide,
	onDelete,
	onPointerEnter,
	onPointerLeave,
	pinned = false,
	onPinnedChange,
	onConvertToNote,
	converting = false,
	frame,
	onFrameChange,
	anchored = false,
	openUp = false,
	bounds = null,
}: TranslateCardProps) {
	const { t } = useTranslation("viewer");
	const showResult = result.trim().length > 0;
	const showLoading = streaming && !showResult;

	return (
		<SelectionCard
			screen={screen}
			width={260}
			height={200}
			// Content-sized: follow the selection pin while the PDF scrolls.
			trackPin
			anchored={anchored}
			openUp={openUp}
			bounds={bounds}
			className={anchored ? "pointer-events-auto" : undefined}
			preferRight={preferRight}
			title={t("selection.translateTitle")}
			icon={Languages}
			ariaLive="polite"
			floating={
				onPinnedChange
					? { pinned, onPinnedChange, frame, onFrameChange }
					: undefined
			}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
			actions={
				onPinnedChange
					? [
							{
								label: t(
									pinned
										? "selection.translateUnpin"
										: "selection.translatePin",
								),
								onClick: () => onPinnedChange(!pinned),
								icon: pinned ? <PinOff /> : <Pin />,
								pressed: pinned,
							},
							...(onConvertToNote
								? [
										{
											label: t("selection.translateToNote"),
											onClick: onConvertToNote,
											icon: <StickyNote />,
											disabled:
												streaming || !showResult || converting || !!error,
										},
									]
								: []),
							{
								label: t("annotations.close"),
								onClick: onHide,
								icon: <X />,
								disabled: converting,
							},
						]
					: [
							{
								label: t("selection.translateDelete"),
								onClick: onDelete,
								icon: <Trash2Icon className="size-3.5" />,
								destructive: true,
							},
							{
								label: t("selection.translateHide"),
								onClick: onHide,
								icon: <MinusIcon className="size-3.5" />,
							},
						]
			}
			bodyClassName="gap-1.5 px-2.5 pt-2 pb-6"
		>
			{showLoading ? (
				<Shimmer className="text-xs" as="p">
					{t("selection.translating")}
				</Shimmer>
			) : null}

			{showResult ? (
				<MessageResponse className="min-w-0 whitespace-pre-wrap break-words text-xs text-foreground leading-snug">
					{result}
				</MessageResponse>
			) : null}

			{!showLoading && !showResult && !error ? (
				<p className="text-muted-foreground text-xs">
					{t("selection.translating")}
				</p>
			) : null}

			{error ? (
				<div className="flex flex-col items-start gap-1.5">
					<p className="text-destructive text-xs" role="alert">
						{error}
					</p>
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="gap-1 px-1.5"
						onClick={onOpenSettings}
					>
						<Settings2Icon className="size-3" />
						{t("selection.translateOpenSettings")}
					</Button>
				</div>
			) : null}
		</SelectionCard>
	);
}
