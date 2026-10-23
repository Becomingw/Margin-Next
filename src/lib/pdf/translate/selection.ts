import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

type TranslateSelection = Pick<PdfTranslateRecord, "page" | "rects" | "quote">;

/** Match the same text at the same location, allowing sub-pixel PDF rounding. */
export function sameTranslateSelection(
	a: TranslateSelection,
	b: TranslateSelection,
): boolean {
	const normalize = (text?: string) => text?.replace(/\s+/g, " ").trim() ?? "";
	return (
		a.page === b.page &&
		!!normalize(a.quote) &&
		normalize(a.quote) === normalize(b.quote) &&
		a.rects.length === b.rects.length &&
		a.rects.every((rect, i) =>
			(["x", "y", "w", "h"] as const).every(
				(key) => Math.abs(rect[key] - b.rects[i][key]) <= 0.001,
			),
		)
	);
}
