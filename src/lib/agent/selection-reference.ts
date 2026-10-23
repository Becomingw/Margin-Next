import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";

export type SelectionOrigin = "pdf" | "markdown";
export type ReferenceAnchor = {
	page: number;
	rects: PdfVisualNormalizedRect[];
};
export type SelectionContext = {
	id: string;
	text: string;
	sourcePath: string;
	origin: SelectionOrigin;
	/** Legacy single-page anchor; anchors carries the complete cross-page selection. */
	page?: number;
	rects?: PdfVisualNormalizedRect[];
	anchors?: ReferenceAnchor[];
	paperAbsPath?: string;
	/** Existing preparse block ids, not a new index or generated summary. */
	regionIds?: string[];
	truncated?: boolean;
	pinned: boolean;
};

export function referenceAnchors(
	reference: SelectionContext,
): ReferenceAnchor[] {
	return reference.anchors?.length
		? reference.anchors
		: reference.page && reference.rects?.length
			? [{ page: reference.page, rects: reference.rects }]
			: [];
}

function validRects(value: unknown): value is PdfVisualNormalizedRect[] {
	return (
		Array.isArray(value) &&
		value.length <= 2000 &&
		value.every(
			(rect) =>
				rect &&
				typeof rect === "object" &&
				["x", "y", "w", "h"].every(
					(key) =>
						typeof rect[key] === "number" &&
						Number.isFinite(rect[key]) &&
						rect[key] >= 0 &&
						rect[key] <= 1,
				),
		)
	);
}

/** Shared validation for inline draft tokens and durable chat attachments. */
export function parseSelectionContext(value: unknown): SelectionContext | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const c = value as Partial<SelectionContext>;
	if (
		typeof c.id !== "string" ||
		!c.id ||
		typeof c.text !== "string" ||
		typeof c.sourcePath !== "string" ||
		(c.origin !== "pdf" && c.origin !== "markdown")
	)
		return null;
	const validPage = (page: unknown): page is number =>
		typeof page === "number" && Number.isInteger(page) && page > 0;
	const anchors = Array.isArray(c.anchors)
		? c.anchors.filter((a) => a && validPage(a.page) && validRects(a.rects))
		: [];
	return {
		id: c.id,
		text: c.text,
		sourcePath: c.sourcePath,
		origin: c.origin,
		pinned: c.pinned === true,
		...(validPage(c.page) ? { page: c.page } : {}),
		...(validRects(c.rects) ? { rects: c.rects } : {}),
		...(anchors.length ? { anchors } : {}),
		...(typeof c.paperAbsPath === "string"
			? { paperAbsPath: c.paperAbsPath }
			: {}),
		...(Array.isArray(c.regionIds)
			? {
					regionIds: c.regionIds
						.filter((id) => typeof id === "string")
						.slice(0, 8),
				}
			: {}),
		...(c.truncated === true ? { truncated: true } : {}),
	};
}

export function sameSelectionReference(
	a: SelectionContext,
	b: SelectionContext,
): boolean {
	if (
		a.sourcePath.replace(/\\/g, "/") !== b.sourcePath.replace(/\\/g, "/") ||
		a.text !== b.text ||
		a.page !== b.page
	)
		return false;
	const aa = referenceAnchors(a),
		bb = referenceAnchors(b);
	return (
		aa.length === bb.length &&
		aa.every(
			(anchor, i) =>
				anchor.page === bb[i].page &&
				anchor.rects.length === bb[i].rects.length &&
				anchor.rects.every((rect, j) =>
					(["x", "y", "w", "h"] as const).every(
						(key) => Math.abs(rect[key] - bb[i].rects[j][key]) <= 0.001,
					),
				),
		)
	);
}

export function referencePageLabel(reference: SelectionContext): string {
	const pages = [
		...new Set(referenceAnchors(reference).map((a) => a.page)),
	].sort((a, b) => a - b);
	return pages.length > 1
		? `${pages[0]}–${pages[pages.length - 1]}`
		: String(pages[0] ?? reference.page ?? "");
}

/** Model-facing quotation: omit rectangles and the auxiliary paperAbsPath. */
export function referencePromptBlock(sel: SelectionContext): string {
	const where = sel.page
		? `${sel.sourcePath} (page ${sel.page})`
		: sel.sourcePath;
	const quoted = sel.text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const hints = sel.regionIds?.length
		? `\nExisting layout blocks: ${sel.regionIds.join(", ")}.`
		: "";
	const pages =
		sel.anchors && sel.anchors.length > 1
			? `\nSelection spans PDF pages ${sel.anchors.map((a) => a.page).join(", ")}.`
			: "";
	return `Selected text from ${where}:\n${quoted}${pages}${hints}${sel.truncated ? "\n[Excerpt truncated; consult the source for the full selection.]" : ""}`;
}
