/**
 * Windowed row list: positions virtual items and dispatches each flattened row
 * to its renderer (virtual rows, inline drafts, paper leaves, files/folders).
 */
import type { Virtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { ObjectIcon } from "@/components/icons/object-icon";
import { contextPathIconKind } from "@/lib/agent/context-path-icon";
import {
	formatPaperTreeLabel,
	type PaperMetadata,
	type PaperTreeLabelMode,
	paperAssetDownloadReasons,
	paperHasVisibleAttachments,
	paperNeedsRead,
} from "@/lib/paper";
import { PLAZA_VIRTUAL_PATH } from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import type { PaperRowActions } from "./hooks/use-paper-row-actions";
import { pathKey } from "./tree-helpers";
import { TreeRenameInput } from "./tree-inputs";
import {
	BrowseAddRow,
	NodeTreeRow,
	PaperTreeRow,
	PlazaRow,
	PlazaSourceRow,
	ReviewTreeRow,
} from "./tree-rows";
import type { FlatRow, TreeRenameDraft } from "./types";

type RowContext = {
	cutPathKeys: ReadonlySet<string>;
	expanded: ReadonlySet<string>;
	loadingDirs: ReadonlySet<string>;
	relPathForNode: (absPath: string) => string;
	paperMetaByRelPath?: ReadonlyMap<string, PaperMetadata>;
	paperTreeLabelMode: PaperTreeLabelMode;
	paperActions: PaperRowActions;
	renameDraft?: TreeRenameDraft | null;
	onConfirmRename?: (path: string, newName: string) => void | Promise<void>;
	onCancelRename?: () => void;
};

export type TreeRowsViewportProps = RowContext & {
	flatRows: FlatRow[];
	rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
	libraryRow: ReactNode;
	trashRow: ReactNode;
	createRow: ReactNode;
};

function PaperLeafRow({
	node,
	ctx,
}: {
	node: FileNode;
	ctx: RowContext;
}): ReactNode {
	const { paperActions: actions } = ctx;
	const meta =
		ctx.paperMetaByRelPath?.get(ctx.relPathForNode(node.path)) ?? null;
	const downloadReasons = paperAssetDownloadReasons(node, meta);
	const showDownload = actions.canDownloadPaper && downloadReasons.length > 0;
	const showRead =
		actions.canReadPaper && !showDownload && paperNeedsRead(node, meta);
	const isDownloading =
		actions.downloadingPath === node.path || actions.downloadingAll;
	const isReading = actions.readingPath === node.path;
	return (
		<PaperTreeRow
			node={node}
			isCut={ctx.cutPathKeys.has(pathKey(node.path))}
			label={formatPaperTreeLabel(ctx.paperTreeLabelMode, meta, node.name)}
			downloadReasons={downloadReasons}
			isDownloading={isDownloading}
			isReading={isReading}
			rowBusy={
				isDownloading ||
				isReading ||
				Boolean(actions.downloadingPath) ||
				actions.downloadingAll ||
				Boolean(actions.readingPath)
			}
			expandable={paperHasVisibleAttachments(node)}
			expanded={ctx.expanded.has(node.path)}
			onDownload={showDownload ? () => actions.downloadPaper(node) : undefined}
			onRead={showRead ? () => actions.readPaper(node) : undefined}
		/>
	);
}

function RenameRow({
	node,
	ctx,
}: {
	node: FileNode;
	ctx: RowContext;
}): ReactNode {
	if (!ctx.renameDraft) return null;
	let icon: ReactNode;
	if (node.kind === "directory") {
		icon = <ObjectIcon kind="folder" className="size-4" />;
	} else {
		icon = (
			<ObjectIcon kind={contextPathIconKind(node.name)} className="size-4" />
		);
	}
	return (
		<TreeRenameInput
			initialName={ctx.renameDraft.currentName}
			icon={icon}
			onConfirm={(newName) => {
				void ctx.onConfirmRename?.(node.path, newName);
			}}
			onCancel={() => ctx.onCancelRename?.()}
		/>
	);
}

function renderRow(row: FlatRow, props: TreeRowsViewportProps): ReactNode {
	if (row.kind === "library") return props.libraryRow;
	if (row.kind === "trash") return props.trashRow;
	if (row.kind === "plaza")
		return <PlazaRow expanded={props.expanded.has(PLAZA_VIRTUAL_PATH)} />;
	if (row.kind === "plazaSource") return <PlazaSourceRow source={row.source} />;
	if (row.kind === "plazaAdd") return <BrowseAddRow />;
	if (row.kind === "create") return props.createRow;
	// Paper folders are leaves and keep their action buttons while renaming.
	if (props.renameDraft?.path === row.node.path) {
		return row.paperLeaf ? null : <RenameRow node={row.node} ctx={props} />;
	}
	if (row.paperLeaf) return <PaperLeafRow node={row.node} ctx={props} />;
	if (row.reviewLeaf) {
		return (
			<ReviewTreeRow
				node={row.node}
				isCut={props.cutPathKeys.has(pathKey(row.node.path))}
				expandable={paperHasVisibleAttachments(row.node)}
				expanded={props.expanded.has(row.node.path)}
			/>
		);
	}
	return (
		<NodeTreeRow
			node={row.node}
			isCut={props.cutPathKeys.has(pathKey(row.node.path))}
			pendingLoad={
				Boolean(row.node.childrenPending) ||
				props.loadingDirs.has(row.node.path)
			}
			expanded={props.expanded.has(row.node.path)}
			atVaultRoot={row.depth === 0}
		/>
	);
}

export function TreeRowsViewport(props: TreeRowsViewportProps) {
	const { flatRows, rowVirtualizer } = props;
	return (
		<div
			className="relative w-full"
			style={{ height: rowVirtualizer.getTotalSize() }}
		>
			{rowVirtualizer.getVirtualItems().map((vi) => {
				const row = flatRows[vi.index];
				if (!row) return null;
				const depth =
					row.kind === "library" || row.kind === "trash" || row.kind === "plaza"
						? 0
						: row.kind === "plazaSource"
							? row.source.panel === "skills"
								? 0
								: 1
							: row.kind === "plazaAdd"
								? 1
								: row.depth;
				return (
					<div
						key={row.key}
						data-index={vi.index}
						ref={rowVirtualizer.measureElement}
						className="absolute left-0 w-full"
						style={{
							// Prefer `top` over `transform: translateY(...)`. Per-row
							// compositor layers go blank in WKWebView (Tauri macOS)
							// after paper open / tree refresh until the next scroll.
							top: vi.start,
							paddingLeft: depth * 12,
						}}
					>
						{renderRow(row, props)}
					</div>
				);
			})}
		</div>
	);
}
