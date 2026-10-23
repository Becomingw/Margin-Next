/**
 * Data-driven column layout + cell renderers for the papers library table.
 * Each entry pairs header meta (label / width / min-width) with a per-paper
 * cell renderer; the table body just walks visible columns.
 */
import { ArrowDown, ArrowUp, ArrowUpDown, File, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { ObjectIcon } from "@/components/icons/object-icon";
import {
	authorsCopyText,
	type CellCtx,
	type ColumnDef,
	identifierValue,
	isMissingLocalPdf,
	type SortDir,
	type SortKey,
} from "@/components/library/library-row-utils";
import { PaperTagChips } from "@/components/library/paper-tag-chip";
import { ReadingTitleHeat } from "@/components/library/reading-heatmap";
import { MathText } from "@/components/ui/math-text";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";
import { formatAuthorsShort, type PaperLibraryRow } from "@/lib/paper";
import type { LibraryColumnPref } from "@/lib/settings";

const COPY_CELL_BASE =
	"cursor-pointer select-text rounded-sm hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Double-click-to-copy cell control shared by library columns. */
function CopyCellButton({
	copyText,
	labelKey,
	ctx,
	className,
	children,
}: {
	copyText: string | null | undefined;
	labelKey: string;
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	className?: string;
	children: ReactNode;
}) {
	const label = ctx.t(labelKey);
	const copyHint = ctx.t("papersLibrary.copyHint", { label });
	const canCopy = Boolean(copyText?.trim());
	return (
		<button
			type="button"
			className={cn(COPY_CELL_BASE, className)}
			title={canCopy ? copyHint : undefined}
			aria-label={copyHint}
			onDoubleClick={() => ctx.onCellCopy(copyText, label)}
		>
			{children}
		</button>
	);
}

/** `<td>` + copy button for plain columns (year / type / id …). */
function CopyTd({
	tdClassName,
	copyText,
	labelKey,
	ctx,
	buttonClassName,
	children,
}: {
	tdClassName: string;
	copyText: string | null | undefined;
	labelKey: string;
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	buttonClassName?: string;
	children: ReactNode;
}) {
	return (
		<td className={tdClassName}>
			<CopyCellButton
				copyText={copyText}
				labelKey={labelKey}
				ctx={ctx}
				className={buttonClassName}
			>
				{children}
			</CopyCellButton>
		</td>
	);
}

/** Local PDF present / missing; review icon + badge for review units. */
function PdfStateIcon({
	p,
	t,
	className = "shrink-0",
}: {
	p: PaperLibraryRow;
	t: CellCtx["t"];
	className?: string;
}) {
	if (p.isReview) {
		return (
			<span className={cn("inline-flex items-center gap-1", className)}>
				<ObjectIcon kind="review" className="size-3.5 shrink-0" />
				<span className="inline-flex items-center gap-1 rounded-sm bg-teal-500/12 px-1.5 py-0.5 text-[11px] font-medium leading-none text-teal-700 ring-1 ring-teal-500/25 dark:text-teal-300">
					{t("papersLibrary.reviewBadge")}
					{p.reviewOpenCount && p.reviewOpenCount > 0 ? (
						<span className="tabular-nums opacity-80">{p.reviewOpenCount}</span>
					) : null}
				</span>
			</span>
		);
	}
	if (p.has_pdf === undefined) return null;
	const label = t(
		isMissingLocalPdf(p)
			? "papersLibrary.noLocalPdf"
			: "papersLibrary.hasLocalPdf",
	);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					className={cn("cursor-help text-muted-foreground", className)}
					aria-label={label}
				>
					{p.has_pdf ? (
						<FileText className="size-3.5 text-red-500/80" aria-hidden />
					) : (
						<File className="size-3.5" aria-hidden />
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Narrow-panel row: the title on up to two lines, then one muted line with
 * the chosen meta columns and the first tags. Empty fields are skipped.
 */
export function PaperListCell({
	p,
	ctx,
	columns,
}: {
	p: PaperLibraryRow;
	ctx: CellCtx;
	columns: LibraryColumnPref[];
}) {
	const shown = new Set(columns.map((col) => col.key));
	const meta = [
		shown.has("authors") ? formatAuthorsShort(p.authors) : "",
		shown.has("year") && p.year ? String(p.year) : "",
		shown.has("publication") ? (p.publication ?? "") : "",
	].filter(Boolean);
	const tags = shown.has("tags") ? ctx.tags : [];
	return (
		<td className="min-w-0 max-w-0 px-4 py-2.5">
			<ReadingTitleHeat heatmap={ctx.heat} className="font-medium leading-snug">
				<PdfStateIcon
					p={p}
					t={ctx.t}
					className="mr-1.5 inline-flex align-[-0.125em]"
				/>
				<MathText text={p.title} />
			</ReadingTitleHeat>
			{meta.length || tags.length ? (
				<div className="mt-1 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
					{meta.length ? (
						<span className="min-w-0 truncate">{meta.join(" · ")}</span>
					) : null}
					<PaperTagChips tags={tags} max={2} className="shrink-0" />
				</div>
			) : null}
		</td>
	);
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
	if (!active) {
		return <ArrowUpDown className="size-3 shrink-0 opacity-40" aria-hidden />;
	}
	return dir === "asc" ? (
		<ArrowUp className="size-3 shrink-0 text-foreground" aria-hidden />
	) : (
		<ArrowDown className="size-3 shrink-0 text-foreground" aria-hidden />
	);
}

/** Column layout + cell renderers (data-driven; no switch in the component). */
export const COLUMN_META = {
	title: {
		labelKey: "papersLibrary.colTitle",
		widthWeight: 36,
		headerClassName: "min-w-[15rem]",
		render: (p, ctx) => (
			<td
				data-column="title"
				className="min-w-0 max-w-0 overflow-hidden px-2 py-2.5"
			>
				<CopyCellButton
					copyText={p.title}
					labelKey="papersLibrary.colTitle"
					ctx={ctx}
					className="block w-full text-left font-medium"
				>
					<ReadingTitleHeat heatmap={ctx.heat} className="line-clamp-1">
						<span className="flex min-w-0 items-center gap-1">
							<PdfStateIcon p={p} t={ctx.t} />
							<MathText text={p.title} className="block min-w-0 truncate" />
						</span>
					</ReadingTitleHeat>
				</CopyCellButton>
			</td>
		),
	},
	authors: {
		labelKey: "papersLibrary.colAuthors",
		widthWeight: 18,
		headerClassName: "min-w-[8.75rem]",
		render: (p, ctx) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-2 py-2.5 text-muted-foreground text-xs">
				<Tooltip>
					<TooltipTrigger asChild>
						<CopyCellButton
							copyText={authorsCopyText(p.authors)}
							labelKey="papersLibrary.colAuthors"
							ctx={ctx}
							className="block w-full text-left"
						>
							<span className="block truncate">
								{formatAuthorsShort(p.authors)}
							</span>
						</CopyCellButton>
					</TooltipTrigger>
					{p.authors && p.authors.length > 2 ? (
						<TooltipContent side="top" align="start" className="max-w-xs">
							{p.authors.join(", ")}
						</TooltipContent>
					) : null}
				</Tooltip>
			</td>
		),
	},
	year: {
		labelKey: "papersLibrary.colYear",
		widthWeight: 9,
		headerClassName: "min-w-16",
		render: (p) => (
			<td className="whitespace-nowrap px-2 py-2.5 tabular-nums text-muted-foreground text-xs">
				{p.year}
			</td>
		),
	},
	publication: {
		labelKey: "papersLibrary.colPublication",
		widthWeight: 14,
		headerClassName: "min-w-[7.5rem]",
		render: (p) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-2 py-2.5 text-muted-foreground text-xs">
				<span className="line-clamp-1" title={p.publication ?? undefined}>
					{p.publication}
				</span>
			</td>
		),
	},
	tags: {
		labelKey: "papersLibrary.colTags",
		widthWeight: 16,
		headerClassName: "min-w-[7.5rem]",
		render: (_p, { tags }) => (
			<td
				data-column="tags"
				className="min-w-0 max-w-0 overflow-hidden px-2 py-2.5"
			>
				<PaperTagChips tags={tags} max={2} />
			</td>
		),
	},
	id: {
		labelKey: "papersLibrary.colId",
		widthWeight: 14,
		headerClassName: "min-w-[10rem]",
		render: (p, ctx) => {
			const value = identifierValue(p);
			return (
				<CopyTd
					tdClassName="min-w-0 max-w-0 overflow-hidden px-2 py-2.5 font-mono text-muted-foreground text-xs"
					copyText={value}
					labelKey="papersLibrary.colId"
					ctx={ctx}
					buttonClassName="block w-full text-left"
				>
					<span className="line-clamp-1" title={value ?? undefined}>
						{value}
					</span>
				</CopyTd>
			);
		},
	},
	citations: {
		labelKey: "papersLibrary.colCitations",
		widthWeight: 11,
		headerClassName: "min-w-[5rem]",
		render: (p) => {
			const count = p.citation_count;
			return (
				<td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
					{count != null
						? new Intl.NumberFormat(undefined).format(count)
						: null}
				</td>
			);
		},
	},
} as const satisfies Record<SortKey, ColumnDef>;

/** A column's share of the table: its dragged width, else the default weight. */
export function columnWeight(col: LibraryColumnPref): number {
	return col.width ?? COLUMN_META[col.key].widthWeight;
}

export { SortIcon };
