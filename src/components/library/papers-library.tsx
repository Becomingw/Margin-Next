/**
 * Vault library: table of all papers from catalog.sqlite (display only).
 * Click column headers to sort ascending / descending.
 * Title-header inline search + tags-header filter (no separate toolbar).
 * Single-click a row to open the paper (deferred so double-click can cancel);
 * double-click a cell to copy that field.
 * Reading heat: title text background as a left→right spine (doc start→end).
 * Layout follows the panel width: secondary columns give way first, and below
 * LIBRARY_LIST_BELOW_REM the table becomes a two-line list.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCellCopy } from "@/components/library/hooks/use-cell-copy";
import { useLibraryHeatmap } from "@/components/library/hooks/use-library-heatmap";
import { columnWeight } from "@/components/library/library-columns";
import { LibraryPaperRow } from "@/components/library/library-paper-row";
import { LibraryPdfDropSurface } from "@/components/library/library-pdf-drop-surface";
import {
	buildPaperRow,
	type CellCtx,
	type CellT,
	comparePaperRows,
	libraryLayout,
	reorderColumns,
	resetColumnWidths,
	type SortDir,
	type SortKey,
	setColumnPairWidths,
	toggleColumnVisibility,
} from "@/components/library/library-row-utils";
import { LibraryTableHeader } from "@/components/library/library-table-header";
import { PaperCodeDialog } from "@/components/library/paper-code-dialog";
import { Button } from "@/components/ui/button";
import { useReviewStore } from "@/hooks/use-app-stores";
import { useDebouncedCallback } from "@/hooks/use-debounce";
import { cn } from "@/lib/core/utils";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import { filterPapersByScope } from "@/lib/paper/api";
import {
	refreshLibraryMetadata,
	refreshPaperMetadata,
} from "@/lib/paper/library-actions";
import { heatmapCacheKey } from "@/lib/paper/reading-heatmap";
import { type PaperTag, visiblePaperTags } from "@/lib/paper/tags";
import { importReviewFiles } from "@/lib/review/actions";
import {
	DEFAULT_LIBRARY_COLUMNS,
	type LibraryColumnPref,
	useUiScale,
} from "@/lib/settings";
import { joinVaultPath } from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { openReviewUnit, openTab } from "@/lib/workspace/actions";

export type PapersLibraryProps = {
	/** Full catalog list (or pre-scoped); further filtered by `scopePath`. */
	papers: PaperLibraryRow[];
	/** Vault root; required to load per-paper reading heatmaps. */
	vaultPath?: string | null;
	/** When the Library tab is focused — reload heatmaps (after PDF activity). */
	active?: boolean;
	loading?: boolean;
	query?: string;
	/** Controlled search string (lives in App so palette/other callers can clear it). */
	onQueryChange?: (query: string) => void;
	/**
	 * Vault-relative folder scope (e.g. `papers/nlp`).
	 * Null/empty = full library. Filters by catalog `path` prefix (recursive).
	 */
	scopePath?: string | null;
	onOpenPaper: (paper: PaperMetadata) => void;
	/**
	 * Column order + visibility (persisted in settings). When omitted, all
	 * columns show in canonical order.
	 */
	columns?: LibraryColumnPref[];
	/** Persist a new column layout (reorder / show-hide / reset). */
	onColumnsChange?: (columns: LibraryColumnPref[]) => void;
	/** Rebuild the catalog from papers/ on disk (empty-state recovery). */
	onRescan?: () => void;
	rescanning?: boolean;
	className?: string;
};

/**
 * Delay before a keystroke commits to the shared library query.
 * Keeps typing local to the input so each key does not re-filter/sort the
 * full catalog (and re-render workspace subscribers of `query`).
 */
const SEARCH_DEBOUNCE_MS = 250;
/** Hide header search/actions while scrolling; restore after this idle gap. */
const HEADER_SCROLL_IDLE_MS = 450;

export function PapersLibrary({
	papers,
	vaultPath = null,
	active = true,
	loading,
	query = "",
	onQueryChange,
	scopePath = null,
	onOpenPaper,
	columns = DEFAULT_LIBRARY_COLUMNS,
	onColumnsChange,
	onRescan,
	rescanning,
	className,
}: PapersLibraryProps) {
	const { t: tRaw, i18n } = useTranslation("sidebar");
	/** Column renderers take plain string keys; cast off strict resource unions. */
	const t = tRaw as unknown as CellT;
	const [sortKey, setSortKey] = useState<SortKey>("title");
	const [sortDir, setSortDir] = useState<SortDir>("asc");
	/** Selected tag names for header filter (OR: paper matches if it has any). */
	const [tagFilter, setTagFilter] = useState<string[]>([]);
	const [kindFilter, setKindFilter] = useState<"all" | "reading" | "review">(
		"all",
	);
	const reviewUnits = useReviewStore((s) => s.units);
	const [codePaper, setCodePaper] = useState<{
		vault: string;
		paper: PaperMetadata;
	} | null>(null);
	const openCode = useCallback(
		(paper: PaperMetadata) => {
			if (vaultPath) setCodePaper({ vault: vaultPath, paper });
		},
		[vaultPath],
	);
	useEffect(() => {
		if (codePaper && codePaper.vault !== vaultPath) setCodePaper(null);
	}, [vaultPath, codePaper]);

	/**
	 * Local mirror of `query`: keystrokes filter the (precomputed) rows here
	 * immediately, but only commit to the shared query after a debounce so
	 * workspace subscribers are not re-rendered on every key.
	 */
	const [inputValue, setInputValue] = useState(query);
	const commitSearch = useDebouncedCallback(
		(value: string) => onQueryChange?.(value),
		SEARCH_DEBOUNCE_MS,
	);

	useEffect(() => {
		setInputValue(query);
		commitSearch.cancel();
	}, [query, commitSearch]);

	useEffect(() => () => commitSearch.cancel(), [commitSearch]);

	const onSearchInputChange = useCallback(
		(value: string) => {
			setInputValue(value);
			commitSearch(value);
		},
		[commitSearch],
	);

	const handleSort = useCallback(
		(key: SortKey) => {
			if (key === sortKey) {
				setSortDir((d) => (d === "asc" ? "desc" : "asc"));
				return;
			}
			setSortKey(key);
			// Year / citation count default to newest/highest first; text columns ascending
			setSortDir(key === "year" || key === "citations" ? "desc" : "asc");
		},
		[sortKey],
	);

	const handleOpenLibraryRow = useCallback(
		(paper: PaperMetadata) => {
			const row = paper as PaperLibraryRow;
			if (row.isReview || paper.path?.startsWith("reviews/")) {
				const unit = reviewUnits.find(
					(u) => `reviews/${u.id}` === paper.path || u.id === paper.id,
				);
				if (unit) {
					openReviewUnit(unit);
					return;
				}
				if (vaultPath && paper.path) {
					openTab(joinVaultPath(vaultPath, `${paper.path}/manuscript.md`), {
						preferMode: "markdown",
					});
					return;
				}
			}
			onOpenPaper(paper);
		},
		[onOpenPaper, reviewUnits, vaultPath],
	);

	const handleImportReview = useCallback(() => {
		if (!vaultPath) return;
		void importReviewFiles(vaultPath).then((units) => {
			if (units[0]) openReviewUnit(units[0]);
		});
	}, [vaultPath]);

	const { onCellCopy, onRowClick, openPaperFromRow } = useCellCopy({
		t,
		onOpenPaper: handleOpenLibraryRow,
	});

	const canEditMeta =
		Boolean(vaultPath) && !isRemoteVaultHandle(vaultPath ?? "");

	const reviewLibraryRows = useMemo<PaperLibraryRow[]>(
		() =>
			reviewUnits.map(
				(u) =>
					({
						path: `reviews/${u.id}`,
						id: u.id,
						type: "other",
						title: u.title,
						authors: u.authors ?? [],
						year: u.year ?? null,
						tags: [],
						status: "completed",
						is_read: false,
						added_at: u.createdAt,
						updated_at: u.updatedAt,
						has_pdf: u.hasPdf,
						isReview: true,
						reviewOpenCount: u.openCount,
					}) as PaperLibraryRow,
			),
		[reviewUnits],
	);

	/** Folder scope first (cheap path-prefix filter on in-memory catalog + reviews). */
	const scopedPapers = useMemo(() => {
		const normScope = (scopePath ?? "")
			.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "");
		if (normScope === "reviews" || normScope.startsWith("reviews/")) {
			return filterPapersByScope(reviewLibraryRows, normScope);
		}
		if (normScope === "papers" || normScope.startsWith("papers/")) {
			return filterPapersByScope(papers, normScope);
		}
		const reading = filterPapersByScope(papers, scopePath);
		if (kindFilter === "reading") return reading;
		if (kindFilter === "review") return reviewLibraryRows;
		return [...reviewLibraryRows, ...reading];
	}, [papers, reviewLibraryRows, scopePath, kindFilter]);

	/** Ordered, visible columns (title stays as a safety fallback). */
	const visibleColumns = useMemo(() => {
		const vis = columns.filter((c) => c.visible);
		return vis.length ? vis : columns.filter((c) => c.key === "title");
	}, [columns]);
	/** Panel width in rem (0 until the scroller is measured). */
	const [widthRem, setWidthRem] = useState(0);
	const layout = useMemo(
		() => libraryLayout(widthRem, visibleColumns),
		[widthRem, visibleColumns],
	);
	const shownColumns = layout.columns;
	/** Live widths while a header edge is being dragged; saved on release. */
	const [draftWidths, setDraftWidths] = useState<Partial<
		Record<SortKey, number>
	> | null>(null);
	const weightOf = useCallback(
		(col: LibraryColumnPref) => draftWidths?.[col.key] ?? columnWeight(col),
		[draftWidths],
	);
	const visibleColumnWeight = useMemo(
		() => shownColumns.reduce((total, col) => total + weightOf(col), 0),
		[shownColumns, weightOf],
	);
	/**
	 * Header edge drag between `left` and `right`, in px of a `tablePx` wide
	 * table. The pair trades width, so the table keeps filling the panel.
	 */
	const handleColumnResize = useCallback(
		(
			left: SortKey,
			right: SortKey,
			leftPx: number,
			rightPx: number,
			tablePx: number,
			done: boolean,
		) => {
			const toWeight = (px: number) => (px / tablePx) * visibleColumnWeight;
			const widths = { [left]: toWeight(leftPx), [right]: toWeight(rightPx) };
			if (!done) {
				setDraftWidths(widths);
				return;
			}
			setDraftWidths(null);
			onColumnsChange?.(setColumnPairWidths(columns, widths));
		},
		[columns, onColumnsChange, visibleColumnWeight],
	);
	const handleColumnWidthReset = useCallback(
		(left: SortKey, right: SortKey) => {
			onColumnsChange?.(resetColumnWidths(columns, [left, right]));
		},
		[columns, onColumnsChange],
	);

	const toggleColumn = useCallback(
		(key: SortKey) => {
			if (!onColumnsChange || key === "title") return;
			onColumnsChange(toggleColumnVisibility(columns, key));
		},
		[columns, onColumnsChange],
	);

	const resetColumns = useCallback(() => {
		onColumnsChange?.(DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })));
	}, [onColumnsChange]);

	const handleColumnReorder = useCallback(
		(fromKey: SortKey, toKey: SortKey) => {
			if (!onColumnsChange || !fromKey) return;
			onColumnsChange(reorderColumns(columns, fromKey, toKey));
		},
		[columns, onColumnsChange],
	);

	const canRefreshMetadata =
		Boolean(vaultPath) && !isRemoteVaultHandle(vaultPath);
	const handleRefreshMetadata = useCallback(() => {
		void refreshLibraryMetadata(vaultPath, scopedPapers);
	}, [vaultPath, scopedPapers]);

	const handleRefreshPaperMetadata = useCallback(
		(paper: PaperMetadata) => {
			void refreshPaperMetadata(vaultPath, paper);
		},
		[vaultPath],
	);

	const normalizedQuery = (inputValue ?? "").trim().toLocaleLowerCase();
	const tagFilterSet = useMemo(() => new Set(tagFilter), [tagFilter]);

	/** Unique tags in the current folder scope (for the tags-column filter menu). */
	const availableTags = useMemo(() => {
		const byName = new Map<string, PaperTag>();
		for (const p of scopedPapers) {
			for (const tag of visiblePaperTags(p.tags)) {
				if (!byName.has(tag.name)) byName.set(tag.name, tag);
			}
		}
		return [...byName.values()].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
	}, [scopedPapers]);

	/** Drop filter selections that no longer exist in scope. */
	useEffect(() => {
		if (!tagFilter.length) return;
		const names = new Set(availableTags.map((t) => t.name));
		const next = tagFilter.filter((n) => names.has(n));
		if (next.length !== tagFilter.length) setTagFilter(next);
	}, [availableTags, tagFilter]);

	const toggleTagFilter = useCallback((name: string) => {
		setTagFilter((prev) =>
			prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
		);
	}, []);

	/** Coerce tags + sort keys once per paper list change (not per keystroke). */
	const indexedRows = useMemo(
		() => scopedPapers.map(buildPaperRow),
		[scopedPapers],
	);

	/** Keystroke-level work is filter + sort over precomputed rows only. */
	const rows = useMemo(() => {
		let filtered = indexedRows;
		if (normalizedQuery) {
			filtered = filtered.filter(
				(row) =>
					String(row.sort.title).includes(normalizedQuery) ||
					row.tagSearch.includes(normalizedQuery),
			);
		}
		if (tagFilterSet.size > 0) {
			filtered = filtered.filter((row) =>
				row.tags.some((tag) => tagFilterSet.has(tag.name)),
			);
		}
		const copy = [...filtered];
		copy.sort((a, b) => comparePaperRows(a, b, sortKey, sortDir));
		return copy;
	}, [indexedRows, normalizedQuery, tagFilterSet, sortKey, sortDir]);

	// Reorder cue: replay a quick fade when the user re-sorts or changes tag
	// filters. Deliberately excludes the search query — per-keystroke remounts
	// would flicker (high-frequency input, motion-15).
	const reorderKey = useMemo(
		() => `${sortKey}:${sortDir}:${kindFilter}:${tagFilter.join(",")}`,
		[sortKey, sortDir, kindFilter, tagFilter],
	);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const detachScrollRef = useRef<(() => void) | null>(null);
	/** True only while the table is scrolling; idle restores search/actions. */
	const [headerCompact, setHeaderCompact] = useState(false);
	/** Bind scroll listener when the table scroller mounts (after loading). */
	const setScrollEl = useCallback((el: HTMLDivElement | null) => {
		detachScrollRef.current?.();
		detachScrollRef.current = null;
		scrollRef.current = el;
		if (!el) {
			setHeaderCompact(false);
			return;
		}
		// Measured in the ref callback so the first paint already has the
		// right layout; uiScale changes the rem size, so read it each time.
		const measure = (width: number) => {
			const remPx =
				Number.parseFloat(
					getComputedStyle(document.documentElement).fontSize,
				) || 16;
			setWidthRem(width / remPx);
		};
		measure(el.clientWidth);
		const resizeObserver = new ResizeObserver(([entry]) => {
			if (entry) measure(entry.contentRect.width);
		});
		resizeObserver.observe(el);
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const onScroll = () => {
			setHeaderCompact((prev) => (prev ? prev : true));
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				idleTimer = null;
				setHeaderCompact(false);
			}, HEADER_SCROLL_IDLE_MS);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		detachScrollRef.current = () => {
			resizeObserver.disconnect();
			if (idleTimer) clearTimeout(idleTimer);
			el.removeEventListener("scroll", onScroll);
		};
	}, []);
	useEffect(
		() => () => {
			detachScrollRef.current?.();
			detachScrollRef.current = null;
		},
		[],
	);
	const uiScale = useUiScale();
	const rowVirtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => Math.round((layout.list ? 64 : 44) * uiScale),
		overscan: 12,
	});
	// Row heights differ between the table and the list.
	useEffect(() => {
		void layout.list;
		rowVirtualizer.measure();
	}, [layout.list, rowVirtualizer]);

	const virtualRows = rowVirtualizer.getVirtualItems();
	const totalSize = rowVirtualizer.getTotalSize();
	const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
	const paddingBottom =
		virtualRows.length > 0
			? totalSize - virtualRows[virtualRows.length - 1].end
			: 0;

	const heatmaps = useLibraryHeatmap({
		vaultPath,
		scopedPapers,
		active,
		rows,
		virtualRows,
	});

	/** Stable t + onCellCopy pair shared by every memoized row. */
	const cellCtx = useMemo<Pick<CellCtx, "t" | "onCellCopy">>(
		() => ({ t, onCellCopy }),
		[t, onCellCopy],
	);

	const filtering = normalizedQuery.length > 0 || tagFilterSet.size > 0;
	const tagFilterActive = tagFilterSet.size > 0;

	let body: ReactNode;
	if (loading) {
		body = (
			<div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
				{t("papersLibrary.loading")}
			</div>
		);
	} else {
		const empty = rows.length === 0;
		body = (
			<>
				<div
					ref={setScrollEl}
					className={cn(
						"edda-scroll-both min-w-0",
						empty ? "h-auto" : "min-h-0 flex-1",
					)}
				>
					<table className="w-full table-fixed border-collapse text-left text-sm">
						{/* Fixed weights keep the table stable while content and rows change. */}
						{layout.list ? null : (
							<colgroup>
								{shownColumns.map((col) => (
									<col
										key={col.key}
										style={{
											width: `${(weightOf(col) / visibleColumnWeight) * 100}%`,
										}}
									/>
								))}
							</colgroup>
						)}
						<LibraryTableHeader
							t={t}
							columns={columns}
							visibleColumns={shownColumns}
							variant={layout.list ? "list" : "table"}
							sortKey={sortKey}
							sortDir={sortDir}
							onSort={handleSort}
							compact={headerCompact}
							searchEnabled={Boolean(onQueryChange)}
							inputValue={inputValue}
							onInputChange={onSearchInputChange}
							canRefreshMetadata={canRefreshMetadata}
							onRefreshMetadata={handleRefreshMetadata}
							availableTags={availableTags}
							tagFilterSet={tagFilterSet}
							tagFilterActive={tagFilterActive}
							onToggleTagFilter={toggleTagFilter}
							onClearTagFilter={() => setTagFilter([])}
							canCustomizeColumns={Boolean(onColumnsChange)}
							onToggleColumn={toggleColumn}
							onResetColumns={resetColumns}
							onColumnReorder={handleColumnReorder}
							onColumnResize={onColumnsChange ? handleColumnResize : undefined}
							onColumnWidthReset={handleColumnWidthReset}
							vaultPath={vaultPath}
							papers={scopedPapers}
							kindFilter={kindFilter}
							onKindFilterChange={setKindFilter}
							onImportReview={
								canRefreshMetadata ? handleImportReview : undefined
							}
						/>
						{/* key={reorderKey} remounts the tbody to replay the fade animation. */}
						<tbody
							key={reorderKey}
							className="animate-in fade-in-0 duration-150"
						>
							{paddingTop > 0 ? (
								<tr aria-hidden>
									<td
										colSpan={layout.list ? 1 : shownColumns.length}
										style={{ height: paddingTop }}
									/>
								</tr>
							) : null}
							{virtualRows.map((vr) => {
								const row = rows[vr.index];
								const p = row.paper;
								return (
									<LibraryPaperRow
										key={p.path ?? p.id}
										index={vr.index}
										row={row}
										heat={heatmaps.get(heatmapCacheKey(p))}
										variant={layout.list ? "list" : "table"}
										visibleColumns={shownColumns}
										ctx={cellCtx}
										paperAbsPath={
											p.path && vaultPath
												? joinVaultPath(vaultPath, p.path)
												: null
										}
										canEditMeta={canEditMeta}
										onOpenPaper={openPaperFromRow}
										onRowClick={onRowClick}
										onRefreshMetadata={handleRefreshPaperMetadata}
										onOpenCode={openCode}
										measureRef={rowVirtualizer.measureElement}
									/>
								);
							})}
							{paddingBottom > 0 ? (
								<tr aria-hidden>
									<td
										colSpan={layout.list ? 1 : shownColumns.length}
										style={{ height: paddingBottom }}
									/>
								</tr>
							) : null}
						</tbody>
					</table>
					{!empty ? (
						<p className="sticky left-0 border-hairline-soft border-t px-3 py-2 text-muted-foreground text-xs tracking-wide">
							{t("papersLibrary.count", {
								count: rows.length,
								formatted: new Intl.NumberFormat(i18n.language).format(
									rows.length,
								),
							})}
						</p>
					) : null}
				</div>
				{empty ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
						<p className="font-medium text-sm">
							{filtering
								? t("papersLibrary.noMatch")
								: t("papersLibrary.emptyTitle")}
						</p>
						{filtering ? null : (
							<p className="max-w-sm text-muted-foreground text-xs">
								{t("papersLibrary.emptyHint")}
							</p>
						)}
						{!filtering && onRescan ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mt-1"
								disabled={rescanning}
								onClick={onRescan}
							>
								<RefreshCw
									className={cn("size-3.5", rescanning && "animate-spin")}
								/>
								{t("papersLibrary.rescan")}
							</Button>
						) : null}
					</div>
				) : null}
			</>
		);
	}

	return (
		<LibraryPdfDropSurface
			scopePath={scopePath}
			className={cn("@container/paper-page overflow-hidden", className)}
		>
			{body}
			{codePaper?.paper.path && vaultPath && codePaper.vault === vaultPath ? (
				<PaperCodeDialog
					key={`${vaultPath}:${codePaper.paper.path}`}
					vault={vaultPath}
					path={codePaper.paper.path}
					title={codePaper.paper.title ?? ""}
					onClose={() => setCodePaper(null)}
				/>
			) : null}
		</LibraryPdfDropSurface>
	);
}
