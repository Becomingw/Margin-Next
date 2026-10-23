import { Palette } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import {
	PDF_PAPER_SWATCH_CLASS,
	PDF_PAPER_TONES,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";

/** Toolbar button opening the PDF paper tone swatches. */
export function PdfPaperTonePicker({
	tone,
	onSetTone,
}: {
	tone: PdfPaperTone;
	onSetTone: (tone: PdfPaperTone) => void;
}) {
	const { t } = useTranslation("viewer");
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							type="button"
							size="icon-xs"
							variant={open ? "secondary" : "ghost"}
							className="shrink-0 self-center"
							aria-label={t("pdf.paperTone")}
						>
							<Palette className="size-3.5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("pdf.paperTone")}</TooltipContent>
			</Tooltip>
			<PopoverContent
				side="bottom"
				align="end"
				className="w-auto flex-row items-center gap-1.5 p-1.5"
			>
				{PDF_PAPER_TONES.map((option) => {
					const label = t(`pdf.paperToneOption.${option}`);
					return (
						<Tooltip key={option}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={label}
									aria-pressed={tone === option}
									className={cn(
										"size-5 shrink-0 rounded-full ring-1 ring-black/15 transition-transform duration-100 hover:scale-105 active:scale-95 dark:ring-white/25",
										PDF_PAPER_SWATCH_CLASS[option],
										tone === option &&
											"ring-2 ring-foreground/70 ring-offset-1 ring-offset-popover",
									)}
									onClick={() => {
										onSetTone(option);
										setOpen(false);
									}}
								/>
							</TooltipTrigger>
							<TooltipContent side="bottom">{label}</TooltipContent>
						</Tooltip>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}
