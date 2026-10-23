/**
 * Sticky header row for the papers library table.
 *
 * Per-column sort button, title-header inline search, metadata refresh,
 * and the tags-filter popover; right-click customizes column order +
 * visibility. When `compact` (table is actively scrolling), search +
 * action icons hide so only column labels remain; row height stays
 * fixed (`h-9`). Transient drag state (dragKey/dragOverKey) lives here —
 * the parent only receives committed reorder events. Memoized so
 * scrolling the virtualized body does not re-render the header unless
 * compact/props change. Narrow panels use the `list` variant: one toolbar
 * row with search, a sort menu and the same actions.
 */
import {
	Award,
	ClipboardCheck,
	ListFilter,
	Plus,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { COLUMN_META, SortIcon } from "@/components/library/library-columns";
import type {
	CellT,
	SortDir,
	SortKey,
} from "@/components/library/library-row-utils";
import { PaperTagChip } from "@/components/library/paper-tag-chip";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	buildEasyScholarTags,
	fetchEasyScholarRank,
	isEasyScholarTag,
} from "@/lib/easyscholar";
import type { PaperMetadata } from "@/lib/paper";
import {
	setLibraryPaperTags,
	startManualPaper,
} from "@/lib/paper/library-store";
import { coercePaperTags, type PaperTag } from "@/lib/paper/tags";
import type { LibraryColumnPref } from "@/lib/settings";

type LibraryTableHeaderProps = {
	t: CellT;
	/** Full column list (order + visibility) for the customization menu. */
	columns: LibraryColumnPref[];
	/** Ordered, visible columns actually rendered as `<th>`. */
	visibleColumns: LibraryColumnPref[];
	sortKey: SortKey;
	sortDir: SortDir;
	onSort: (key: SortKey) => void;
	/**
	 * Actively scrolling: hide search input and header action icons,
	 * keep column label text (and active sort chevron). Idle restores.
	 */
	compact?: boolean;
	/** `list`: one toolbar row (search, sort menu, actions) for narrow panels. */
	variant: "table" | "list";
	/** Inline title search; hidden when the shared query is not controlled. */
	searchEnabled: boolean;
	inputValue: string;
	onInputChange: (value: string) => void;
	/** Metadata refresh (local vault only). */
	canRefreshMetadata: boolean;
	onRefreshMetadata: () => void;
	/** Tags-column filter popover. */
	availableTags: PaperTag[];
	tagFilterSet: Set<string>;
	tagFilterActive: boolean;
	onToggleTagFilter: (name: string) => void;
	onClearTagFilter: () => void;
	/** Column customization (drag reorder + show/hide menu). */
	canCustomizeColumns: boolean;
	onToggleColumn: (key: SortKey) => void;
	onResetColumns: () => void;
	onColumnReorder: (fromKey: SortKey, toKey: SortKey) => void;
	/**
	 * Drag of the edge between two columns, in px of the `tablePx` wide table;
	 * `done` on release. Absent = widths are fixed.
	 */
	onColumnResize?: (
		left: SortKey,
		right: SortKey,
		leftPx: number,
		rightPx: number,
		tablePx: number,
		done: boolean,
	) => void;
	/** Double-click on an edge: both columns back to their default width. */
	onColumnWidthReset: (left: SortKey, right: SortKey) => void;
	/** Vault path for EasyScholar batch tag fetch. */
	vaultPath?: string | null;
	/** Papers currently visible in the library scope. */
	papers: PaperMetadata[];
	/** Filter between all items, reading papers only, or review papers only. */
	kindFilter?: "all" | "reading" | "review";
	onKindFilterChange?: (next: "all" | "reading" | "review") => void;
	onImportReview?: () => void;
};

export const LibraryTableHeader = memo(function LibraryTableHeader({
	t,
	columns,
	visibleColumns,
	sortKey,
	sortDir,
	onSort,
	compact = false,
	variant,
	searchEnabled,
	inputValue,
	onInputChange,
	canRefreshMetadata,
	onRefreshMetadata,
	availableTags,
	tagFilterSet,
	tagFilterActive,
	onToggleTagFilter,
	onClearTagFilter,
	canCustomizeColumns,
	onToggleColumn,
	onResetColumns,
	onColumnReorder,
	onColumnResize,
	onColumnWidthReset,
	vaultPath,
	papers,
	kindFilter = "all",
	onKindFilterChange,
	onImportReview,
}: LibraryTableHeaderProps) {
	// --- Column customization (order + visibility) ---
	const [dragKey, setDragKey] = useState<SortKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<SortKey | null>(null);
	const [tagFilterOpen, setTagFilterOpen] = useState(false);
	const [rankBusy, setRankBusy] = useState(false);
	/** Left column of the edge being dragged (keeps its line visible). */
	const [resizingKey, setResizingKey] = useState<SortKey | null>(null);

	useEffect(() => {
		if (compact) setTagFilterOpen(false);
	}, [compact]);

	// The list toolbar has no column labels to fall back to, so it never hides.
	const showActions = variant === "list" || !compact;
	/** Fade chrome in place (keeps h-9); hide instantly, restore with fade-in. */
	const chromeFadeClass = showActions
		? "opacity-100 duration-300"
		: "pointer-events-none opacity-0 duration-0";
	const canFetchRanks = Boolean(vaultPath) && !rankBusy && papers.length > 0;

	const fetchAllRanks = async () => {
		if (!vaultPath || rankBusy) return;
		setRankBusy(true);
		let updated = 0;
		let failed = 0;
		let empty = 0;
		try {
			for (const paper of papers) {
				const title = paper.publication?.trim();
				if (!title || !paper.path) continue;
				try {
					const response = await fetchEasyScholarRank(title);
					const data = response.data?.officialRank?.all;
					if (!data || Object.keys(data).length === 0) {
						empty += 1;
						continue;
					}
					const newTags = buildEasyScholarTags(title, data);
					const allTags = coercePaperTags(paper.tags);
					const base = allTags.filter((tag) => !isEasyScholarTag(tag.name));
					await setLibraryPaperTags(vaultPath, paper.path, [
						...base,
						...newTags,
					]);
					updated += 1;
				} catch {
					failed += 1;
					// Continue with the next paper; summarize at the end.
				}
			}
			notifySuccess(
				t("papersLibrary.easyScholar.batchDone", { updated, failed, empty }),
			);
		} catch (err) {
			notifyError(t("papersLibrary.easyScholar.fetchFailed"), {
				description: errorMessage(err),
			});
		} finally {
			setRankBusy(false);
		}
	};

	const actionClass = (className?: string) =>
		cn(
			"flex size-6 shrink-0 items-center justify-center rounded-sm",
			"hover:bg-muted/60 hover:text-foreground",
			"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
			"transition-opacity ease-out",
			chromeFadeClass,
			className,
		);
	const actionTabIndex = showActions ? undefined : -1;

	const addButton = canRefreshMetadata ? (
		<>
			<button
				type="button"
				data-library-header-action
				className={actionClass()}
				title={t("papersLibrary.addPaper")}
				aria-label={t("papersLibrary.addPaper")}
				tabIndex={actionTabIndex}
				onClick={startManualPaper}
			>
				<Plus className="size-3.5" />
			</button>
			{onImportReview ? (
				<button
					type="button"
					data-library-header-action
					className={actionClass()}
					title={t("fileTree.importReview")}
					aria-label={t("fileTree.importReview")}
					tabIndex={actionTabIndex}
					onClick={(e) => {
						e.stopPropagation();
						onImportReview();
					}}
				>
					<ClipboardCheck className="size-3.5" />
				</button>
			) : null}
		</>
	) : null;

	const kindFilterPills = onKindFilterChange ? (
		<div
			data-library-header-action
			className={cn(
				"inline-flex h-6 shrink-0 items-center rounded-md bg-muted/70 p-0.5 text-[11px]",
				chromeFadeClass,
			)}
		>
			{(["all", "reading", "review"] as const).map((k) => {
				const selected = kindFilter === k;
				const labelKey =
					k === "all"
						? "papersLibrary.filterAll"
						: k === "reading"
							? "papersLibrary.filterReading"
							: "papersLibrary.filterReview";
				return (
					<button
						key={k}
						type="button"
						tabIndex={actionTabIndex}
						className={cn(
							"h-5 rounded-xs px-1.5 font-medium transition-colors",
							selected
								? "bg-background text-foreground shadow-xs"
								: "text-muted-foreground hover:text-foreground",
						)}
						onMouseDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation();
							onKindFilterChange(k);
						}}
					>
						{t(labelKey)}
					</button>
				);
			})}
		</div>
	) : null;

	const searchBox = (className: string) =>
		searchEnabled ? (
			<div
				className={cn(
					"transition-opacity ease-out",
					chromeFadeClass,
					className,
				)}
				aria-hidden={!showActions}
			>
				<Search
					className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground"
					aria-hidden
				/>
				<Input
					type="search"
					value={inputValue}
					onChange={(e) => onInputChange(e.target.value)}
					aria-label={t("papersLibrary.search")}
					tabIndex={actionTabIndex}
					className="h-6 border-transparent bg-muted/70 pl-6 pr-1.5 text-xs shadow-none placeholder:text-muted-foreground/70 focus-visible:border-hairline-soft focus-visible:bg-card"
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				/>
			</div>
		) : null;

	const refreshButton = (className?: string) =>
		canRefreshMetadata ? (
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						data-library-header-action
						tabIndex={actionTabIndex}
						className={actionClass(className)}
						aria-hidden={!showActions}
						aria-label={t("papersLibrary.refreshMetadata")}
						onClick={(e) => {
							e.stopPropagation();
							onRefreshMetadata();
						}}
						onMouseDown={(e) => e.stopPropagation()}
					>
						<RefreshCw className="size-3.5" aria-hidden />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{t("papersLibrary.refreshMetadata")}
				</TooltipContent>
			</Tooltip>
		) : null;

	const rankButton = (className?: string) => (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					data-library-header-action
					disabled={!canFetchRanks}
					tabIndex={actionTabIndex}
					className={actionClass(
						cn(
							"disabled:pointer-events-none",
							showActions && "disabled:opacity-50",
							className,
						),
					)}
					aria-hidden={!showActions}
					aria-label={t("papersLibrary.easyScholar.fetchRank")}
					title={t("papersLibrary.easyScholar.fetchRank")}
					onClick={(e) => {
						e.stopPropagation();
						void fetchAllRanks();
					}}
					onMouseDown={(e) => e.stopPropagation()}
				>
					<Award className="size-3.5" aria-hidden />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{t("papersLibrary.easyScholar.fetchRank")}
			</TooltipContent>
		</Tooltip>
	);

	const tagFilterMenu = (className?: string) => (
		<Popover open={tagFilterOpen} onOpenChange={setTagFilterOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							data-library-header-action
							tabIndex={actionTabIndex}
							className={actionClass(
								cn(
									tagFilterActive &&
										showActions &&
										"bg-muted/60 text-foreground",
									className,
								),
							)}
							aria-hidden={!showActions}
							aria-label={t("papersLibrary.filterTags")}
							aria-pressed={tagFilterActive}
							onClick={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
						>
							<ListFilter className="size-3.5" aria-hidden />
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{t("papersLibrary.filterTags")}
				</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="start"
				className="w-56 p-2"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{availableTags.length === 0 ? (
					<p className="px-1 py-2 text-muted-foreground text-xs">
						{t("papersLibrary.filterTagsEmpty")}
					</p>
				) : (
					<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
						{availableTags.map((tag) => {
							const selected = tagFilterSet.has(tag.name);
							return (
								<button
									key={tag.name}
									type="button"
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs",
										"hover:bg-muted/60",
										selected && "bg-muted/50",
									)}
									aria-pressed={selected}
									onClick={() => onToggleTagFilter(tag.name)}
								>
									<span
										className={cn(
											"flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
											selected
												? "border-primary bg-primary text-primary-foreground"
												: "border-muted-foreground/40",
										)}
										aria-hidden
									>
										{selected ? (
											<span className="text-caption leading-none">✓</span>
										) : null}
									</span>
									<PaperTagChip tag={tag} />
								</button>
							);
						})}
					</div>
				)}
				{tagFilterActive ? (
					<>
						<div className="my-1.5 h-px bg-border" />
						<button
							type="button"
							className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs hover:bg-muted/60 hover:text-foreground"
							onClick={onClearTagFilter}
						>
							<X className="size-3" aria-hidden />
							{t("papersLibrary.clearTagFilter")}
						</button>
					</>
				) : null}
			</PopoverContent>
		</Popover>
	);

	/** The two header cells around an edge, and the table they share. */
	const edgeCells = (handle: HTMLElement) => {
		const leftCell = handle.closest("th");
		const rightCell = leftCell?.nextElementSibling;
		const table = leftCell?.closest("table");
		if (!leftCell || !(rightCell instanceof HTMLElement) || !table) return null;
		const remPx =
			Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
			16;
		return {
			leftPx: leftCell.getBoundingClientRect().width,
			rightPx: rightCell.getBoundingClientRect().width,
			tablePx: table.getBoundingClientRect().width,
			minPx: 3.5 * remPx,
		};
	};
	/** New pair widths after moving the edge by `dx`, neither below its minimum. */
	const movedEdge = (
		cells: NonNullable<ReturnType<typeof edgeCells>>,
		left: SortKey,
		dx: number,
	) => {
		const total = cells.leftPx + cells.rightPx;
		// The title keeps room for a readable line.
		const leftMin = left === "title" ? cells.minPx * 3 : cells.minPx;
		const leftPx = Math.min(
			Math.max(cells.leftPx + dx, leftMin),
			total - cells.minPx,
		);
		return [leftPx, total - leftPx] as const;
	};
	const resizeHandle = (left: SortKey, right: SortKey) =>
		onColumnResize ? (
			<button
				type="button"
				aria-label={t("papersLibrary.resizeColumn")}
				title={t("papersLibrary.resizeColumn")}
				data-column-resize
				className="group/resize absolute top-0 right-0 z-[2] flex h-full w-2 translate-x-1/2 cursor-col-resize touch-none justify-center focus-visible:outline-none"
				onMouseDown={(e) => e.preventDefault()}
				onClick={(e) => e.stopPropagation()}
				onDoubleClick={(e) => {
					e.stopPropagation();
					onColumnWidthReset(left, right);
				}}
				onPointerDown={(e) => {
					if (e.button !== 0) return;
					const cells = edgeCells(e.currentTarget);
					if (!cells) return;
					e.preventDefault();
					e.stopPropagation();
					const startX = e.clientX;
					let last = [cells.leftPx, cells.rightPx] as const;
					setResizingKey(left);
					const move = (ev: PointerEvent) => {
						last = movedEdge(cells, left, ev.clientX - startX);
						onColumnResize(left, right, last[0], last[1], cells.tablePx, false);
					};
					const up = () => {
						window.removeEventListener("pointermove", move);
						setResizingKey(null);
						if (last[0] !== cells.leftPx) {
							onColumnResize(
								left,
								right,
								last[0],
								last[1],
								cells.tablePx,
								true,
							);
						}
					};
					window.addEventListener("pointermove", move);
					window.addEventListener("pointerup", up, { once: true });
				}}
				onKeyDown={(e) => {
					const step =
						e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
					if (!step) return;
					e.preventDefault();
					e.stopPropagation();
					const cells = edgeCells(e.currentTarget);
					if (!cells) return;
					const [leftPx, rightPx] = movedEdge(cells, left, step);
					onColumnResize(left, right, leftPx, rightPx, cells.tablePx, true);
				}}
			>
				<span
					className={cn(
						"h-full w-px transition-colors duration-100",
						resizingKey === left
							? "bg-ring"
							: "group-hover/resize:bg-hairline-soft group-focus-visible/resize:bg-ring",
					)}
				/>
			</button>
		) : null;

	const headerClassName =
		"sticky top-0 z-[1] select-none border-b border-transparent bg-background/72 shadow-[0_1px_0_0_var(--hairline-soft)] backdrop-blur-xl backdrop-saturate-150 supports-backdrop-blur:bg-background/60";
	const showsTags = visibleColumns.some((col) => col.key === "tags");

	const listToolbar = (
		<thead data-library-header className={headerClassName}>
			<tr className="text-muted-foreground text-xs">
				<th className="p-0 font-normal">
					<div className="flex h-10 min-w-0 items-center gap-1 px-3">
						{kindFilterPills}
						{searchBox("relative mr-1 min-w-0 flex-1")}
						{addButton}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									data-library-header-action
									className={actionClass("w-auto max-w-32 gap-1 px-1.5")}
									aria-label={t("papersLibrary.sortBy", {
										column: t(COLUMN_META[sortKey].labelKey),
									})}
								>
									<span className="truncate">
										{t(COLUMN_META[sortKey].labelKey)}
									</span>
									<SortIcon active dir={sortDir} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-40">
								{visibleColumns.map((col) => (
									<DropdownMenuItem
										key={col.key}
										onSelect={() => onSort(col.key)}
									>
										{t(COLUMN_META[col.key].labelKey)}
										{sortKey === col.key ? (
											<span className="ml-auto">
												<SortIcon active dir={sortDir} />
											</span>
										) : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
						{refreshButton()}
						{showsTags ? (
							<>
								{rankButton()}
								{tagFilterMenu()}
							</>
						) : null}
					</div>
				</th>
			</tr>
		</thead>
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				{variant === "list" ? (
					listToolbar
				) : (
					<thead data-library-header className={headerClassName}>
						<tr className="text-muted-foreground text-xs tracking-wide">
							{visibleColumns.map((col, index) => {
								const meta = COLUMN_META[col.key];
								const next = visibleColumns[index + 1];
								const active = sortKey === col.key;
								const isDragOver =
									dragOverKey === col.key && dragKey !== col.key;
								return (
									<th
										key={col.key}
										data-column={col.key}
										className={cn(
											meta.headerClassName,
											"relative p-0 font-medium",
											dragKey === col.key && "opacity-50",
											isDragOver && "bg-muted",
										)}
										aria-sort={
											active
												? sortDir === "asc"
													? "ascending"
													: "descending"
												: "none"
										}
										draggable={canCustomizeColumns}
										onDragStart={(e) => {
											const target = e.target as HTMLElement;
											if (
												target.closest(
													"input,button[data-library-header-action],[data-column-resize]",
												)
											) {
												e.preventDefault();
												return;
											}
											setDragKey(col.key);
											e.dataTransfer.effectAllowed = "move";
											e.dataTransfer.setData("text/plain", col.key);
										}}
										onDragOver={(e) => {
											if (!dragKey) return;
											e.preventDefault();
											e.dataTransfer.dropEffect = "move";
											if (dragOverKey !== col.key) setDragOverKey(col.key);
										}}
										onDrop={(e) => {
											e.preventDefault();
											const from = dragKey;
											setDragKey(null);
											setDragOverKey(null);
											if (!from || from === col.key) return;
											onColumnReorder(from, col.key);
										}}
										onDragEnd={() => {
											setDragKey(null);
											setDragOverKey(null);
										}}
									>
										{/* Fixed h-9 so compact fade never changes header height. */}
										<div className="flex h-9 min-w-0 items-center gap-1 px-2">
											<button
												type="button"
												className={cn(
													"flex min-w-0 shrink items-center gap-1 py-0.5 text-left cursor-grab active:cursor-grabbing",
													"hover:text-foreground",
													"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
													active && "text-foreground",
												)}
												onClick={() => onSort(col.key)}
												aria-label={t("papersLibrary.sortBy", {
													column: t(meta.labelKey),
												})}
											>
												<span className="truncate">{t(meta.labelKey)}</span>
												<span
													className={cn(
														"inline-flex transition-opacity ease-out",
														showActions || active
															? "opacity-100 duration-300"
															: "opacity-0 duration-0",
													)}
													aria-hidden={!showActions && !active}
												>
													<SortIcon active={active} dir={sortDir} />
												</span>
												{col.key === "tags" ? (
													<span
														className={cn(
															"size-1.5 shrink-0 rounded-full bg-primary transition-opacity ease-out",
															!showActions && tagFilterActive
																? "opacity-100 duration-300"
																: "opacity-0 duration-0",
														)}
														aria-hidden
													/>
												) : null}
											</button>
											{col.key === "title" ? (
												<>
													{kindFilterPills}
													{addButton}
													{searchBox("relative ml-1 min-w-0 flex-1")}
												</>
											) : null}
											{col.key === "publication" ? refreshButton("ml-1") : null}
											{col.key === "tags" ? (
												<>
													{rankButton("ml-1")}
													{tagFilterMenu("ml-auto")}
												</>
											) : null}
										</div>
										{next ? resizeHandle(col.key, next.key) : null}
									</th>
								);
							})}
						</tr>
					</thead>
				)}
			</ContextMenuTrigger>
			<ContextMenuContent className="w-44">
				<ContextMenuLabel>
					{t("papersLibrary.columnsMenuLabel")}
				</ContextMenuLabel>
				{columns.map((col) => (
					<ContextMenuCheckboxItem
						key={col.key}
						checked={col.visible}
						disabled={col.key === "title" || !canCustomizeColumns}
						onSelect={(e) => e.preventDefault()}
						onCheckedChange={() => onToggleColumn(col.key)}
					>
						{t(COLUMN_META[col.key].labelKey)}
					</ContextMenuCheckboxItem>
				))}
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={!canCustomizeColumns}
					onSelect={() => onResetColumns()}
				>
					{t("papersLibrary.resetColumns")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});
