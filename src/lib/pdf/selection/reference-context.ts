import type { ReferenceAnchor } from "@/lib/agent/selection-reference";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";

/** Only inspect already loaded preparse blocks; never start parsing for a quote. */
export function selectionLayoutRegionIds(
	anchors: ReferenceAnchor[],
	regions: readonly PdfLayoutRegion[],
): string[] {
	return regions
		.filter(
			(region) =>
				["text", "abstract", "header"].includes(region.kind) &&
				anchors.some(
					(anchor) =>
						anchor.page === region.pageIndex + 1 &&
						anchor.rects.some((rect) => {
							const b = region.bbox;
							const overlap =
								Math.max(
									0,
									Math.min(rect.x + rect.w, b.x + b.w) - Math.max(rect.x, b.x),
								) *
								Math.max(
									0,
									Math.min(rect.y + rect.h, b.y + b.h) - Math.max(rect.y, b.y),
								);
							return rect.w * rect.h > 0 && overlap / (rect.w * rect.h) >= 0.5;
						}),
				),
		)
		.sort(
			(a, b) => a.pageIndex - b.pageIndex || a.readingOrder - b.readingOrder,
		)
		.slice(0, 8)
		.map((region) => region.id);
}
