import { ChevronRight, Download, Loader2, Plus, Zap } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import {
	FileTreeActions,
	FileTreeDisclosureIcon,
	FileTreeFile,
	FileTreeFolderRow,
	FileTreeIcon,
	FileTreeName,
	useFileTree,
} from "@/components/ai-elements/file-tree";
import { ObjectIcon, objectIcon } from "@/components/icons/object-icon";
import { openAddBrowseSite } from "@/components/plaza/browse-site-dialog";
import { PLAZA_SOURCE_ICONS } from "@/components/plaza/source-icons";
import { Button } from "@/components/ui/button";
import { MathText } from "@/components/ui/math-text";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReviewStore } from "@/hooks/use-app-stores";
import { contextPathIconKind } from "@/lib/agent/context-path-icon";
import { cn } from "@/lib/core/utils";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import {
	PLAZA_VIRTUAL_PATH,
	type PlazaSource,
	plazaSourceLabel,
} from "@/lib/plaza";
import { pathsEqual } from "@/lib/review/paths";
import type { FileNode } from "@/lib/vault";
import { DOWNLOAD_REASON_KEYS } from "./tree-helpers";

type PaperTreeRowProps = {
	node: FileNode;
	isCut: boolean;
	label: string;
	downloadReasons: Array<keyof typeof DOWNLOAD_REASON_KEYS>;
	isDownloading: boolean;
	isReading: boolean;
	rowBusy: boolean;
	expandable: boolean;
	expanded: boolean;
	onDownload?: () => void;
	onRead?: () => void;
};

export function PaperTreeRow({
	node,
	isCut,
	label,
	downloadReasons,
	isDownloading,
	isReading,
	rowBusy,
	expandable,
	expanded,
	onDownload,
	onRead,
}: PaperTreeRowProps) {
	const { t } = useTranslation("sidebar");
	const { togglePath } = useFileTree();
	const expandLabel = expanded
		? t("fileTree.collapseAttachments")
		: t("fileTree.expandAttachments");
	const showDownload = Boolean(onDownload) && downloadReasons.length > 0;
	const showRead = Boolean(onRead) && !showDownload;
	const reasonTip = downloadReasons.length
		? downloadReasons.map((r) => t(DOWNLOAD_REASON_KEYS[r])).join(" · ")
		: t("fileTree.downloadAssets");
	const showActions = showDownload || showRead;
	return (
		<FileTreeFile
			path={node.path}
			name={label}
			className={cn(isCut && "opacity-50")}
		>
			{expandable ? (
				<Tooltip disableHoverableContent>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-expanded={expanded}
							aria-label={expandLabel}
							className={cn(
								"group/attachment relative flex size-4 shrink-0 items-center justify-center rounded-sm",
								"text-muted-foreground hover:bg-muted/80",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							)}
							onClick={(e) => {
								e.stopPropagation();
								e.preventDefault();
								togglePath(node.path);
							}}
							onPointerDown={(e) => e.stopPropagation()}
							onKeyDown={(e) => e.stopPropagation()}
						>
							<ObjectIcon
								kind="paper"
								className="size-4 transition-opacity group-hover/attachment:opacity-0 group-focus-visible/attachment:opacity-0"
							/>
							<ChevronRight
								className={cn(
									"pointer-events-none absolute size-4 opacity-0 transition-[opacity,transform] group-hover/attachment:opacity-100 group-focus-visible/attachment:opacity-100",
									expanded && "rotate-90",
								)}
								aria-hidden
							/>
						</button>
					</TooltipTrigger>
					<TooltipContent side="right" className="select-none cursor-default">
						{expandLabel}
					</TooltipContent>
				</Tooltip>
			) : (
				<ObjectIcon kind="paper" className="size-4 shrink-0" />
			)}
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				<MathText text={label} />
			</FileTreeName>
			{showActions ? (
				<FileTreeActions
					className="shrink-0"
					onClick={(e) => {
						e.stopPropagation();
					}}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{showDownload ? (
						<Tooltip disableHoverableContent>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="size-5"
									aria-label={reasonTip}
									disabled={rowBusy}
									onClick={(e) => {
										e.stopPropagation();
										onDownload?.();
									}}
								>
									{isDownloading ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Download className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent
								side="right"
								className="max-w-xs select-none cursor-default flex-col items-start gap-0"
							>
								<p className="font-medium">{t("fileTree.downloadAssets")}</p>
								<ul className="mt-1 list-disc space-y-0.5 pl-3 text-xs opacity-90">
									{downloadReasons.map((r) => (
										<li key={r}>{t(DOWNLOAD_REASON_KEYS[r])}</li>
									))}
								</ul>
							</TooltipContent>
						</Tooltip>
					) : null}
					{showRead ? (
						<Tooltip disableHoverableContent>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									className="size-5"
									data-read-paper
									aria-label={t("fileTree.readPaper")}
									disabled={rowBusy}
									onClick={(e) => {
										e.stopPropagation();
										onRead?.();
									}}
								>
									{isReading ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Zap className="size-3.5" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent
								side="right"
								className="max-w-xs select-none cursor-default"
							>
								<p className="font-medium">{t("fileTree.readPaper")}</p>
							</TooltipContent>
						</Tooltip>
					) : null}
				</FileTreeActions>
			) : null}
		</FileTreeFile>
	);
}

type NodeTreeRowProps = {
	node: FileNode;
	isCut: boolean;
	pendingLoad: boolean;
	expanded: boolean;
	/** Direct child of the vault root (where `papers/` and `notes/` live). */
	atVaultRoot: boolean;
};

/** The vault's own top-level folders read as what they hold, not as folders. */
const ROOT_FOLDER_ICONS: Record<
	string,
	ComponentType<SVGProps<SVGSVGElement>>
> = {
	papers: objectIcon("papers"),
	reviews: objectIcon("reviews"),
	notes: objectIcon("notes"),
};

type ReviewTreeRowProps = {
	node: FileNode;
	isCut: boolean;
	expandable: boolean;
	expanded: boolean;
};

export function ReviewTreeRow({
	node,
	isCut,
	expandable,
	expanded,
}: ReviewTreeRowProps) {
	const { t } = useTranslation("review");
	const { togglePath } = useFileTree();
	const unit = useReviewStore((s) =>
		s.units.find((u) => pathsEqual(u.path, node.path)),
	);
	const isParsing = useReviewStore((s) =>
		unit ? Boolean(s.parsing[unit.id]) : false,
	);
	const label = unit?.title?.trim() || node.name;
	const openCount = unit?.openCount ?? 0;

	return (
		<FileTreeFile
			path={node.path}
			name={label}
			className={cn(isCut && "opacity-50")}
		>
			{expandable ? (
				<button
					type="button"
					aria-expanded={expanded}
					className={cn(
						"group/attachment relative flex size-4 shrink-0 items-center justify-center rounded-sm",
						"text-muted-foreground hover:bg-muted/80",
						"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					)}
					onClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						togglePath(node.path);
					}}
					onPointerDown={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					<ObjectIcon
						kind="review"
						className="size-4 transition-opacity group-hover/attachment:opacity-0 group-focus-visible/attachment:opacity-0"
					/>
					<ChevronRight
						className={cn(
							"pointer-events-none absolute size-4 opacity-0 transition-[opacity,transform] group-hover/attachment:opacity-100 group-focus-visible/attachment:opacity-100",
							expanded && "rotate-90",
						)}
						aria-hidden
					/>
				</button>
			) : (
				<ObjectIcon kind="review" className="size-4 shrink-0" />
			)}
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				<MathText text={label} />
			</FileTreeName>
			{isParsing ? (
				<Loader2
					className="size-3.5 shrink-0 animate-spin text-muted-foreground"
					aria-hidden
				/>
			) : openCount > 0 ? (
				<span
					className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-caption text-muted-foreground tabular-nums"
					title={t("tree.openCount", { count: openCount })}
				>
					{openCount}
				</span>
			) : null}
		</FileTreeFile>
	);
}

export function NodeTreeRow({
	node,
	isCut,
	pendingLoad,
	expanded,
	atVaultRoot,
}: NodeTreeRowProps) {
	if (node.kind === "directory") {
		return (
			<div
				className={cn(
					"relative flex w-full items-center",
					isCut && "opacity-50",
				)}
			>
				<div className="min-w-0 flex-1">
					<FileTreeFolderRow
						path={node.path}
						name={node.name}
						icon={atVaultRoot ? ROOT_FOLDER_ICONS[node.name] : undefined}
					/>
				</div>
				{pendingLoad && expanded ? (
					<Loader2
						className="pointer-events-none absolute right-2 size-3.5 shrink-0 animate-spin text-muted-foreground"
						aria-hidden
					/>
				) : null}
			</div>
		);
	}
	return (
		<FileTreeFile
			path={node.path}
			name={node.name}
			icon={
				<ObjectIcon kind={contextPathIconKind(node.name)} className="size-4" />
			}
			className={cn(isCut && "opacity-50")}
		/>
	);
}

type LibraryRowProps = {
	showDownload: boolean;
	busy: boolean;
	downloadingAll: boolean;
	onDownloadAll: () => void;
};

export function LibraryRow({
	showDownload,
	busy,
	downloadingAll,
	onDownloadAll,
}: LibraryRowProps) {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile
			path={LIBRARY_VIRTUAL_PATH}
			name={t("papersLibrary.title")}
			data-library-row
		>
			<FileTreeIcon>
				<ObjectIcon kind="library" className="size-4" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("papersLibrary.title")}
			</FileTreeName>
			{showDownload ? (
				<FileTreeActions
					className="shrink-0"
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					<Tooltip disableHoverableContent>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="size-5"
								aria-label={t("fileTree.downloadAllMissing")}
								disabled={busy}
								onClick={(e) => {
									e.stopPropagation();
									onDownloadAll();
								}}
							>
								{downloadingAll ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Download className="size-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="right"
							className="max-w-xs select-none cursor-default"
						>
							{t("fileTree.downloadAllMissing")}
						</TooltipContent>
					</Tooltip>
				</FileTreeActions>
			) : null}
		</FileTreeFile>
	);
}

export function TrashRow() {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile path={TRASH_VIRTUAL_PATH} name={t("recycleBin.title")}>
			<FileTreeIcon>
				<ObjectIcon kind="trash" className="size-4" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("recycleBin.title")}
			</FileTreeName>
		</FileTreeFile>
	);
}

/** 广场 parent row — collapsible, with the discovery sources as children. */
export function PlazaRow({ expanded }: { expanded: boolean }) {
	const { t } = useTranslation("sidebar");
	return (
		<FileTreeFile
			path={PLAZA_VIRTUAL_PATH}
			name={t("plaza.plaza")}
			aria-expanded={expanded}
		>
			<FileTreeDisclosureIcon
				isExpanded={expanded}
				icon={<ObjectIcon kind="globe" className="size-4" />}
			/>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("plaza.plaza")}
			</FileTreeName>
		</FileTreeFile>
	);
}

export function PlazaSourceRow({ source }: { source: PlazaSource }) {
	const Icon = PLAZA_SOURCE_ICONS[source.icon];
	const label = plazaSourceLabel(source);
	return (
		<FileTreeFile
			path={source.path}
			name={label}
			{...(source.id === "cool-papers" ? { "data-cool-papers": "" } : {})}
		>
			<FileTreeIcon>
				<Icon className="size-4" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate" title={label}>
				{label}
			</FileTreeName>
		</FileTreeFile>
	);
}

/** Last row under 浏览 (Browse): add a website. */
export function BrowseAddRow() {
	const { t } = useTranslation("sidebar");
	return (
		<button
			type="button"
			className="group flex h-7 min-h-7 w-full items-center gap-1 rounded-sm px-4 text-left text-muted-foreground transition-colors duration-100 hover:bg-muted/50 hover:text-foreground active:bg-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			onClick={openAddBrowseSite}
		>
			<FileTreeIcon>
				<Plus className="size-4" />
			</FileTreeIcon>
			<FileTreeName className="min-w-0 flex-1 truncate">
				{t("plaza.browse.addSite")}
			</FileTreeName>
		</button>
	);
}

export function LoadingRows() {
	return (
		<div className="space-y-1 px-2 py-1.5" aria-hidden>
			{["one", "two", "three", "four", "five"].map((key, index) => (
				<div key={key} className="flex h-7 items-center gap-2 rounded-sm px-2">
					<Skeleton className="size-4 shrink-0 library-shimmer" />
					<Skeleton
						className={cn(
							"library-shimmer h-3",
							index === 0 ? "w-32" : index === 1 ? "w-24" : "w-28",
						)}
					/>
				</div>
			))}
		</div>
	);
}
