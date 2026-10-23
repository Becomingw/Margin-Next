import { PanelsTopLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LayoutMode } from "@/lib/shell/ui-store";

type LayoutMenuProps = {
	value: LayoutMode;
	onValueChange: (mode: Exclude<LayoutMode, "custom">) => void;
};

/** Title-bar menu for the three paper-reading workbench presets. */
export function LayoutMenu({ value, onValueChange }: LayoutMenuProps) {
	const { t } = useTranslation("app");
	const selected = value === "custom" ? "" : value;

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("titlebar.layout")}
					title={t("titlebar.layout")}
				>
					<PanelsTopLeft className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuLabel>{t("titlebar.layoutModes")}</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={selected}
					onValueChange={(next) => {
						if (next === "agent" || next === "notes" || next === "reading") {
							onValueChange(next);
						}
					}}
				>
					<DropdownMenuRadioItem value="agent">
						{t("titlebar.layoutAgent")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="notes">
						{t("titlebar.layoutNotes")}
					</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="reading">
						{t("titlebar.layoutReading")}
					</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
