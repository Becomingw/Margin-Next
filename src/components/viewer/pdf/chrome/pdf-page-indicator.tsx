import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { SiArxiv } from "react-icons/si";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

type PdfPageIndicatorProps = {
	/** Hidden until the document reports its page count. */
	totalPages: number;
	/** Editable page number (raw digits while typing). */
	pageField: string;
	onPageFieldChange: (value: string) => void;
	/** True while the field owns focus, so scrolling does not clobber typing. */
	pageFocusedRef: RefObject<boolean>;
	onCommitPageField: () => void;
	/** True for remote arXiv papers with no local sidecar. */
	isRemotePaper?: boolean;
};

/**
 * Page position tucked into the bottom-right corner: small and faint until
 * hovered or edited, so it never sits over the text column. Click the number
 * to jump. Zoom has no on-screen control — Ctrl/⌘+wheel, pinch and
 * right-drag are handled by `WheelZoomHandler`.
 */
export function PdfPageIndicator({
	totalPages,
	pageField,
	onPageFieldChange,
	pageFocusedRef,
	onCommitPageField,
	isRemotePaper = false,
}: PdfPageIndicatorProps) {
	const { t } = useTranslation("viewer");

	if (totalPages <= 0) return null;

	const pageDigits = Math.max(2, String(totalPages).length, pageField.length);

	return (
		<div className="pointer-events-none absolute right-5 bottom-2 z-20 flex select-none items-center gap-1">
			{isRemotePaper ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="pointer-events-auto flex items-center rounded-md bg-background/70 p-1 opacity-70 backdrop-blur-sm">
							<SiArxiv className="size-3 text-[#B31B1B]" aria-hidden />
						</span>
					</TooltipTrigger>
					<TooltipContent side="top">{t("pdf.remoteMode")}</TooltipContent>
				</Tooltip>
			) : null}
			<div
				data-pdf-chrome
				className="pointer-events-auto flex items-center rounded-md bg-background/70 px-1 py-0.5 text-muted-foreground text-xs tabular-nums opacity-60 backdrop-blur-sm transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100"
			>
				<input
					type="text"
					inputMode="numeric"
					className="min-w-5 rounded-sm bg-transparent text-center outline-none focus:bg-muted focus:text-foreground"
					style={{ width: `${pageDigits + 1}ch` }}
					aria-label={t("pdf.goToPage")}
					value={pageField}
					// WebKit drops the focus-time select() on mouseup, so a typed digit
					// would append to the current page. Take over focus on press.
					onMouseDown={(e) => {
						if (document.activeElement === e.currentTarget) return;
						e.preventDefault();
						e.currentTarget.focus();
					}}
					onFocus={(e) => {
						pageFocusedRef.current = true;
						e.currentTarget.select();
					}}
					onChange={(e) =>
						onPageFieldChange(e.target.value.replace(/[^0-9]/g, ""))
					}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							onCommitPageField();
							e.currentTarget.blur();
						}
					}}
					onBlur={() => {
						pageFocusedRef.current = false;
						onCommitPageField();
					}}
				/>
				<span className="pr-0.5">/ {totalPages}</span>
			</div>
		</div>
	);
}
