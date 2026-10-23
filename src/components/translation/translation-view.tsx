import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	expandLayoutTranslateBbox,
	fontSizeForLayoutTranslateBox,
	LayoutTranslateParagraph,
} from "@/components/viewer/pdf/layers/layout-translate-overlay";
import { cn } from "@/lib/core/utils";
import {
	currentLayoutTranslateCacheKey,
	type LayoutTranslateItem,
	type LayoutTranslateSidecar,
	type PdfLayoutRegion,
	type PdfLayoutSidecar,
	readLayoutSidecar,
	readLayoutTranslateSidecar,
} from "@/lib/pdf/layout";
import { isLayoutTranslateHeadingKind } from "@/lib/pdf/layout/labels";
import {
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_BLOCK_CLASS,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";
import { registerScrollSyncPeer } from "@/lib/pdf/scroll-sync";

type TranslationViewProps = {
	/** Absolute path to the paper folder (papers/<id>/). */
	paperAbsPath: string | null;
	/** Stable workspace document id used by the source/translation sync pair. */
	docId: string;
	/** Whether this tab is the active dockview panel. */
	active?: boolean;
};

type PageSize = { width: number; height: number };

type PageRenderSpec = {
	pageIndex: number;
	pageSize: PageSize;
	items: readonly LayoutTranslateItem[];
	regions: readonly PdfLayoutRegion[];
};

const POINTS_PER_PX = 72 / 96;

function estimatePageSizesFromRegions(
	regions: PdfLayoutSidecar["regions"],
): Map<number, PageSize> {
	const sizes = new Map<number, PageSize>();
	const pages = new Set(regions.map((r) => r.pageIndex));
	for (const pageIndex of pages) {
		let width = 0;
		let height = 0;
		for (const r of regions) {
			if (r.pageIndex !== pageIndex) continue;
			if (r.bbox.w > 0.02) width = Math.max(width, r.rect.w / r.bbox.w);
			if (r.bbox.h > 0.02) height = Math.max(height, r.rect.h / r.bbox.h);
		}
		if (width > 0 && height > 0) {
			sizes.set(pageIndex, { width, height });
		}
	}
	return sizes;
}

function toLayoutTranslateItem(
	item: LayoutTranslateSidecar["items"][number],
): LayoutTranslateItem {
	return { ...item, status: "done" as const };
}

function groupItemsByPage(
	items: LayoutTranslateSidecar["items"] | undefined,
): Map<number, LayoutTranslateItem[]> {
	const grouped = new Map<number, LayoutTranslateItem[]>();
	if (!items) return grouped;
	for (const item of items) {
		const layoutItem = toLayoutTranslateItem(item);
		const bucket = grouped.get(layoutItem.pageIndex);
		if (bucket) bucket.push(layoutItem);
		else grouped.set(layoutItem.pageIndex, [layoutItem]);
	}
	for (const bucket of grouped.values()) {
		bucket.sort(
			(a, b) =>
				a.readingOrder - b.readingOrder ||
				a.bbox.y - b.bbox.y ||
				a.bbox.x - b.bbox.x,
		);
	}
	return grouped;
}

function buildPageSpecs(
	layout: PdfLayoutSidecar | null,
	translate: LayoutTranslateSidecar | null,
): PageRenderSpec[] {
	if (!layout) return [];
	const pageSizes = estimatePageSizesFromRegions(layout.regions);
	const itemsByPage = groupItemsByPage(translate?.items);
	const pageIndexes = new Set<number>();
	for (const idx of pageSizes.keys()) pageIndexes.add(idx);
	for (const idx of itemsByPage.keys()) pageIndexes.add(idx);
	const specs: PageRenderSpec[] = [];
	for (const pageIndex of [...pageIndexes].sort((a, b) => a - b)) {
		const pageSize = pageSizes.get(pageIndex);
		if (!pageSize) continue;
		const items = itemsByPage.get(pageIndex) ?? [];
		const regions = layout.regions.filter((r) => r.pageIndex === pageIndex);
		specs.push({ pageIndex, pageSize, items, regions });
	}
	return specs;
}

function TranslatedBlock({
	item,
	pageWidthPx,
	pageHeightPx,
	tone,
	layoutRegions,
}: {
	item: LayoutTranslateItem;
	pageWidthPx: number;
	pageHeightPx: number;
	tone: PdfPaperTone;
	layoutRegions: readonly PdfLayoutRegion[];
}) {
	const text = item.translated ?? "";
	const isHeading = isLayoutTranslateHeadingKind(item.kind);
	const bbox = expandLayoutTranslateBbox(item, layoutRegions);
	const fontSize = fontSizeForLayoutTranslateBox(
		bbox,
		pageWidthPx,
		pageHeightPx,
		item.source,
		text,
	);
	return (
		<div
			className={cn(
				"absolute z-[1] overflow-hidden rounded-[1px]",
				PDF_PAPER_BLOCK_CLASS[tone],
				"text-zinc-900",
				tone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
			)}
			style={{
				left: `${bbox.x * 100}%`,
				top: `${bbox.y * 100}%`,
				width: `${bbox.w * 100}%`,
				height: `${bbox.h * 100}%`,
				padding: "1px 2px",
				fontSize,
				lineHeight: 1.25,
				fontFamily:
					'ui-serif, "Times New Roman", Times, "Noto Serif SC", "Songti SC", "Source Han Serif SC", serif',
				fontWeight: isHeading ? 700 : 400,
				textAlign: isHeading ? "left" : "justify",
			}}
		>
			<LayoutTranslateParagraph
				text={text}
				initialFontSize={fontSize}
				boxWidthPx={pageWidthPx * bbox.w}
				boxHeightPx={pageHeightPx * bbox.h}
				isHeading={isHeading}
			/>
		</div>
	);
}

function TranslatedPage({
	spec,
	tone,
	zoom,
}: {
	spec: PageRenderSpec;
	tone: PdfPaperTone;
	zoom: number;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const renderSize = {
		width: (spec.pageSize.width / POINTS_PER_PX) * zoom,
		height: (spec.pageSize.height / POINTS_PER_PX) * zoom,
	};

	const doneItems = spec.items.filter(
		(it) => it.status === "done" && it.translated?.trim(),
	);

	return (
		<div
			ref={containerRef}
			className="flex min-h-0 w-full items-start justify-center py-3"
		>
			<div
				className={cn(
					"relative shrink-0 overflow-hidden shadow-sm",
					PDF_PAPER_BLOCK_CLASS[tone],
					tone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
				)}
				style={{
					width: renderSize.width,
					height: renderSize.height,
				}}
			>
				{doneItems.map((item) => (
					<TranslatedBlock
						key={item.id}
						item={item}
						pageWidthPx={renderSize.width}
						pageHeightPx={renderSize.height}
						tone={tone}
						layoutRegions={spec.regions}
					/>
				))}
			</div>
		</div>
	);
}

export function TranslationView({
	paperAbsPath,
	docId,
	active = true,
}: TranslationViewProps) {
	const { t } = useTranslation("viewer");
	const { resolvedTheme } = useTheme();
	const [layoutSidecar, setLayoutSidecar] = useState<PdfLayoutSidecar | null>(
		null,
	);
	const [translateSidecar, setTranslateSidecar] =
		useState<LayoutTranslateSidecar | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const [zoom, setZoom] = useState(1);
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	const zoomListenersRef = useRef(new Set<(next: number) => void>());
	const scrollRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional reload trigger.
	useEffect(() => {
		setLayoutSidecar(null);
		setTranslateSidecar(null);
		if (!paperAbsPath) return;
		let cancelled = false;
		void (async () => {
			const [layout, translate] = await Promise.all([
				readLayoutSidecar(paperAbsPath),
				readLayoutTranslateSidecar(
					paperAbsPath,
					currentLayoutTranslateCacheKey(),
				),
			]);
			if (cancelled) return;
			setLayoutSidecar(layout);
			setTranslateSidecar(translate);
		})();
		return () => {
			cancelled = true;
		};
	}, [paperAbsPath, refreshKey]);

	// Re-read the sidecars when this tab becomes active so progressive
	// full-document translation results appear without reopening the tab.
	const wasActiveRef = useRef(active);
	useEffect(() => {
		if (!wasActiveRef.current && active) {
			setRefreshKey((k) => k + 1);
		}
		wasActiveRef.current = active;
	}, [active]);

	const pages = useMemo(
		() => buildPageSpecs(layoutSidecar, translateSidecar),
		[layoutSidecar, translateSidecar],
	);

	// The scroll container does not exist while sidecars are loading; re-bind
	// when the page list first becomes renderable.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pages.length tracks the DOM container lifecycle.
	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		return registerScrollSyncPeer(docId, {
			getMetrics: () => ({
				scrollTop: element.scrollTop,
				scrollLeft: element.scrollLeft,
				scrollHeight: element.scrollHeight,
				scrollWidth: element.scrollWidth,
				clientHeight: element.clientHeight,
				clientWidth: element.clientWidth,
			}),
			scrollTo: ({ x, y }) => {
				element.scrollLeft = x;
				element.scrollTop = y;
			},
			onScrollChange: (listener) => {
				element.addEventListener("scroll", listener, { passive: true });
				return () => element.removeEventListener("scroll", listener);
			},
			getZoom: () => zoomRef.current,
			setZoom: (nextZoom) => {
				const clamped = Math.max(0.2, nextZoom);
				setZoom(clamped);
				zoomRef.current = clamped;
				for (const listener of zoomListenersRef.current) listener(clamped);
			},
			onZoomChange: (listener) => {
				zoomListenersRef.current.add(listener);
				return () => zoomListenersRef.current.delete(listener);
			},
		});
	}, [docId, pages.length]);

	const tone: PdfPaperTone = resolvedTheme === "dark" ? "dark" : "white";

	if (!paperAbsPath) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
				{t("pdf.translation.noPaper")}
			</div>
		);
	}

	if (pages.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
				{t("pdf.translation.empty")}
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			className="edda-scroll flex h-full flex-col items-center overflow-auto bg-muted/20"
		>
			{pages.map((spec) => (
				<TranslatedPage
					key={spec.pageIndex}
					spec={spec}
					tone={tone}
					zoom={zoom}
				/>
			))}
		</div>
	);
}
