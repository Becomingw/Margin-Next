import type { PdfHighlightAnnoObject } from "@embedpdf/models";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
	type UsePdfHighlightsOptions,
	usePdfHighlights,
} from "@/components/viewer/pdf/hooks/use-pdf-highlights";
import { saveAnnotationItems } from "@/lib/pdf/highlight/annotation-store";

vi.mock("react", () => ({
	useState: (value: unknown) => [value, vi.fn()],
	useRef: (current: unknown) => ({ current }),
	useCallback: (callback: unknown) => callback,
	useMemo: (factory: () => unknown) => factory(),
	useEffect: () => {},
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/components/viewer/pdf/layers/citation-links", () => ({
	isLinkObject: () => false,
}));
vi.mock("@/lib/pdf/highlight/annotation-store", () => ({
	annotationGeneration: () => 0,
	saveAnnotationItems: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/pdf/highlight/migrate-marks", () => ({}));
vi.mock("@/lib/pdf/selection", () => ({}));
vi.mock("@/lib/vault/file-change-gate", () => ({}));

const pages = [0, 1].map((pageIndex) => ({
	pageIndex,
	rect: { origin: { x: 10, y: 20 }, size: { width: 100, height: 30 } },
	segmentRects: [
		{ origin: { x: 10, y: 20 }, size: { width: 100, height: 30 } },
	],
})) as unknown as FormattedSelection[];
function harness() {
	const annotations: PdfHighlightAnnoObject[] = [];
	const scope = {
		createAnnotation: vi.fn(
			(_pageIndex: number, object: PdfHighlightAnnoObject) => {
				annotations.push(object);
			},
		),
		deleteAnnotation: vi.fn((_pageIndex: number, id: string) => {
			const index = annotations.findIndex((item) => item.id === id);
			if (index >= 0) annotations.splice(index, 1);
		}),
		exportAnnotations: () => ({
			toPromise: async () =>
				annotations.map((annotation) => ({ annotation: { ...annotation } })),
		}),
	};
	// biome-ignore lint/correctness/useHookAtTopLevel: Testing the real annotation creation/persistence callbacks without EmbedPDF rendering.
	const h = usePdfHighlights({
		annotationCap: { forDocument: () => scope },
		docCap: null,
		docId: "pdf",
		paperAbsPath: "/vault/paper",
		paperKey: "paper",
		totalPages: 2,
		onHighlightsChangeRef: { current: undefined },
	} as unknown as UsePdfHighlightsOptions);
	return { ...h, scope, annotations };
}
beforeEach(() => vi.clearAllMocks());
it("creates a source-anchored note with one translation body and persists it", async () => {
	const h = harness();
	await h.createSelectionNote(pages, "Original selection", "译文");
	expect(h.annotations).toHaveLength(2);
	expect(h.annotations[0]).toMatchObject({
		pageIndex: 0,
		rect: pages[0].rect,
		contents: "译文",
		custom: { quote: "Original selection" },
	});
	expect(h.annotations[1].contents).toBeUndefined();
	expect(saveAnnotationItems).toHaveBeenCalledExactlyOnceWith(
		"/vault/paper",
		expect.arrayContaining([
			expect.objectContaining({
				annotation: expect.objectContaining({ contents: "译文" }),
			}),
		]),
		0,
	);
});
it("rolls back only the new annotations on write failure, and can retry", async () => {
	const h = harness();
	h.createHighlights([pages[0]], "yellow", "Existing note");
	const existingId = h.annotations[0].id;
	vi.mocked(saveAnnotationItems).mockRejectedValueOnce(new Error("Disk full"));
	await expect(
		h.createSelectionNote(pages, "Original selection", "译文"),
	).rejects.toThrow("Disk full");
	expect(h.annotations.map((item) => item.id)).toEqual([existingId]);
	await h.createSelectionNote(pages, "Original selection", "译文");
	expect(h.annotations).toHaveLength(3);
});
it("rolls back a partial cross-page creation failure", async () => {
	const h = harness();
	h.scope.createAnnotation
		.mockImplementationOnce((_index, annotation) => {
			h.annotations.push(annotation);
		})
		.mockImplementationOnce(() => {
			throw new Error("Page unavailable");
		});
	await expect(
		h.createSelectionNote(pages, "Original selection", "译文"),
	).rejects.toThrow("Page unavailable");
	expect(h.annotations).toHaveLength(0);
	expect(saveAnnotationItems).not.toHaveBeenCalled();
});

it("serializes conversions so a later save includes both notes", async () => {
	let finish!: () => void;
	vi.mocked(saveAnnotationItems).mockReturnValueOnce(
		new Promise<void>((resolve) => {
			finish = resolve;
		}),
	);
	const h = harness();
	const first = h.createSelectionNote([pages[0]], "First source", "First note");
	const second = h.createSelectionNote(
		[pages[1]],
		"Second source",
		"Second note",
	);
	for (let i = 0; i < 4; i++) await Promise.resolve();
	expect(h.annotations).toHaveLength(1);
	finish();
	await Promise.all([first, second]);
	expect(saveAnnotationItems).toHaveBeenCalledTimes(2);
	expect(vi.mocked(saveAnnotationItems).mock.calls[1][1]).toHaveLength(2);
});
