/**
 * Right-click menu state for the vault tree: which row is targeted, the derived
 * menu capabilities, and every menu action (reveal, terminal, create, rename,
 * cut/paste, move, delete, library export, empty trash).
 */

import type { TFunction } from "i18next";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { openRenameBrowseSite } from "@/components/plaza/browse-site-dialog";
import { broadcastAgentAttachContext } from "@/lib/agent/context-attach";
import { removeBrowseSite } from "@/lib/browse/native-view";
import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
import { type BrowseSite, commands } from "@/lib/core/bindings";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { displayPath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { isPaperDirectory, isPapersRoot } from "@/lib/paper";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import { importLocalPdf } from "@/lib/paper/import-actions";
import {
	browseSiteForPath,
	PLAZA_SOURCES,
	PLAZA_VIRTUAL_PATH,
} from "@/lib/plaza";
import { importReviewFiles } from "@/lib/review/actions";
import {
	isProtectedVaultRoot,
	isReviewsRootDir,
	isReviewUnitDir,
	isUnderReviews,
} from "@/lib/review/paths";
import { getSettings, patchSettings } from "@/lib/settings/react-store";
import { type FileNode, resolveCreateParent } from "@/lib/vault";
import { isManagedPaperLocation } from "@/lib/vault/path";
import { openInTerminal, revealInFileManager } from "@/lib/vault/reveal";
import { openReviewUnit } from "@/lib/workspace/actions";
import type { TreeContextMenuPortalProps } from "../tree-context-menu";
import { pathKey } from "../tree-helpers";
import type {
	TreeContextMenu,
	TreeCreateDraft,
	TreeCreateKind,
	TreeRenameDraft,
} from "../types";

/** Virtual rows and `edda:` pseudo paths have no OS location. */
function canRevealPath(path: string): boolean {
	return Boolean(path) && !path.startsWith(`${VIRTUAL_PATH_PREFIX}`);
}

/** Menu actions for a user-added Browse website (none for other rows). */
function browseSiteMenu(
	site: BrowseSite | null,
	close: () => void,
	t: TFunction<"sidebar">,
): Partial<TreeContextMenuPortalProps> {
	if (!site) return {};
	return {
		browseSite: site,
		onRenameSite: () => {
			close();
			openRenameBrowseSite(site);
		},
		onOpenSiteExternally: () => {
			close();
			openExternalUrl(site.url);
		},
		onClearSiteSignIn: () => {
			close();
			void callApiResult(() => commands.browseClearSite({ url: site.url }))
				.then(() =>
					notifySuccess(t("plaza.browse.signedOut", { name: site.name })),
				)
				.catch((error) => notifyError(String(error)));
		},
		onRemoveSite: () => {
			close();
			removeBrowseSite(site.id);
		},
	};
}

export type TreeContextMenuState = {
	/** Non-null while the menu is open — spread onto `TreeContextMenuPortal`. */
	menuProps: TreeContextMenuPortalProps | null;
	/** Reveal / open-in-terminal failure shown under the tree. */
	revealError: string | null;
	handleContextMenuPath: (path: string, event: ReactMouseEvent) => void;
};

export function useTreeContextMenu({
	nodes,
	vaultPath,
	byPath,
	cutPaths,
	cutPathKeys,
	createDraft,
	renameDraft,
	libraryExportBusy,
	citingScanBusy,
	pathsForAction,
	prepareContextSelection,
	openMovePicker,
	onExportLibrary,
	onDiscoverCiting,
	onEmptyTrash,
	onOpenPaperNotes,
	onEditPaperMeta,
	onStartCreate,
	onStartRename,
	onDeletePath,
	onDeletePaths,
	onCutPaths,
	onPasteInto,
	onMoveTo,
}: {
	nodes: FileNode[];
	vaultPath: string | null;
	byPath: ReadonlyMap<string, FileNode>;
	cutPaths: string[];
	cutPathKeys: ReadonlySet<string>;
	createDraft: TreeCreateDraft | null;
	renameDraft?: TreeRenameDraft | null;
	libraryExportBusy: boolean;
	citingScanBusy: boolean;
	pathsForAction: (path: string) => string[];
	/** Right-click keeps an existing group, otherwise makes this the sole target. */
	prepareContextSelection: (path: string) => void;
	openMovePicker: (paths: string[], anchor?: { x: number; y: number }) => void;
	onExportLibrary?: () => void | Promise<void>;
	onDiscoverCiting?: () => void | Promise<void>;
	onEmptyTrash?: () => void | Promise<void>;
	onOpenPaperNotes?: (paperDir: string) => void;
	onEditPaperMeta?: (paperDir: string) => void;
	onStartCreate?: (kind: TreeCreateKind, parentPath: string) => void;
	onStartRename?: (path: string) => void;
	onDeletePath?: (path: string) => void | Promise<void>;
	onDeletePaths?: (paths: string[]) => void | Promise<void>;
	onCutPaths?: (paths: string[]) => void;
	onPasteInto?: (targetPath: string) => void;
	onMoveTo?: (paths: string[], destParentRel: string) => void;
}): TreeContextMenuState {
	const { t } = useTranslation("sidebar");
	const [menu, setMenu] = useState<TreeContextMenu | null>(null);
	const [revealError, setRevealError] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => setMenu(null), []);

	const handleContextMenuPath = useCallback(
		(path: string, event: ReactMouseEvent) => {
			if (createDraft || renameDraft) return;
			// Real vault paths + virtual Library (export) / Recycle Bin (empty) /
			// Plaza root (source visibility toggles) / user Browse sites.
			if (
				!canRevealPath(path) &&
				path !== TRASH_VIRTUAL_PATH &&
				path !== LIBRARY_VIRTUAL_PATH &&
				path !== PLAZA_VIRTUAL_PATH &&
				!browseSiteForPath(path)
			) {
				return;
			}
			// Library menu only when it has at least one action wired.
			if (
				path === LIBRARY_VIRTUAL_PATH &&
				!onExportLibrary &&
				!onDiscoverCiting
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			prepareContextSelection(path);
			setRevealError(null);
			setMenu({ path, x: event.clientX, y: event.clientY });
		},
		[
			createDraft,
			renameDraft,
			onExportLibrary,
			onDiscoverCiting,
			prepareContextSelection,
		],
	);

	const reveal = useCallback(
		(path: string) => {
			setMenu(null);
			if (!canRevealPath(path)) return;
			if (!isTauri()) {
				setRevealError(t("fileTree.revealDesktopOnly"));
				return;
			}
			setRevealError(null);
			void revealInFileManager(path).catch(() => {
				setRevealError(t("fileTree.revealFailed"));
			});
		},
		[t],
	);

	const openTerminal = useCallback(
		(path: string) => {
			setMenu(null);
			if (!canRevealPath(path)) return;
			if (!isTauri()) {
				setRevealError(t("fileTree.openInTerminalDesktopOnly"));
				return;
			}
			setRevealError(null);
			void openInTerminal(path).catch(() => {
				setRevealError(t("fileTree.openInTerminalFailed"));
			});
		},
		[t],
	);

	const copyPath = useCallback(
		(path: string) => {
			setMenu(null);
			void copyTextToClipboard(displayPath(path), {
				successMessage: t("fileTree.copiedPath"),
				errorMessage: t("fileTree.copyPathFailed"),
				successNotify: { duration: 2000 },
			});
		},
		[t],
	);

	// Toggle a Plaza source without closing the menu (multi-toggle friendly).
	const togglePlazaSource = useCallback((id: string) => {
		const current = getSettings().plazaHiddenSources;
		patchSettings({
			plazaHiddenSources: current.includes(id)
				? current.filter((s) => s !== id)
				: [...current, id],
		});
	}, []);

	if (!menu) {
		return { menuProps: null, revealError, handleContextMenuPath };
	}

	const targets = pathsForAction(menu.path);
	const menuNode = byPath.get(menu.path);
	const isPaperMenu =
		menuNode?.kind === "directory" &&
		isPaperDirectory(menuNode.path, menuNode.children);
	const isReviewMenu =
		menuNode?.kind === "directory" && isReviewUnitDir(menuNode.path);
	const isPapersRootMenu = Boolean(vaultPath && isPapersRoot(menu.path));
	const isReviewsRootMenu = Boolean(
		vaultPath && isReviewsRootDir(vaultPath, menu.path),
	);
	const managedPaper = Boolean(
		vaultPath && isManagedPaperLocation(vaultPath, menu.path),
	);
	const managedReview = Boolean(
		vaultPath && (isReviewsRootMenu || isUnderReviews(menu.path)),
	);
	const hasProtectedRootTarget = targets.some((p) =>
		isProtectedVaultRoot(vaultPath, p),
	);
	const hasManagedTarget = targets.some(
		(p) =>
			(vaultPath && isManagedPaperLocation(vaultPath, p)) ||
			isReviewsRootDir(vaultPath, p) ||
			isUnderReviews(p),
	);
	const targetIsVirtual =
		menu.path === LIBRARY_VIRTUAL_PATH || menu.path === TRASH_VIRTUAL_PATH;
	const targetKey = pathKey(menu.path);
	const canPasteAtTarget =
		cutPaths.length > 0 &&
		!managedPaper &&
		!managedReview &&
		!targetIsVirtual &&
		Boolean(menu.path) &&
		!cutPathKeys.has(targetKey) &&
		!cutPaths.some((p) => targetKey.startsWith(`${pathKey(p)}/`));

	const menuProps: TreeContextMenuPortalProps = {
		menu,
		menuRef,
		menuCount: targets.length,
		menuNodeName: menuNode?.name,
		isPaperMenu,
		libraryExportBusy,
		citingScanBusy,
		canPasteAtTarget,
		plazaSources:
			menu.path === PLAZA_VIRTUAL_PATH
				? PLAZA_SOURCES.filter(
						(source) =>
							source.panel !== "skills" && source.panel !== "paperPool",
					).map((source) => ({
						source,
						hidden: getSettings().plazaHiddenSources.includes(source.id),
					}))
				: undefined,
		onTogglePlazaSource:
			menu.path === PLAZA_VIRTUAL_PATH ? togglePlazaSource : undefined,
		onClose: close,
		...browseSiteMenu(browseSiteForPath(menu.path), close, t),
		onExportLibrary: onExportLibrary
			? () => {
					setMenu(null);
					void onExportLibrary();
				}
			: undefined,
		onDiscoverCiting: onDiscoverCiting
			? () => {
					setMenu(null);
					void onDiscoverCiting();
				}
			: undefined,
		onEmptyTrash: onEmptyTrash
			? () => {
					setMenu(null);
					void onEmptyTrash();
				}
			: undefined,
		onOpenNotes:
			isPaperMenu && onOpenPaperNotes
				? () => {
						setMenu(null);
						onOpenPaperNotes(menu.path);
					}
				: undefined,
		onEditMeta:
			isPaperMenu && onEditPaperMeta
				? () => {
						setMenu(null);
						onEditPaperMeta(menu.path);
					}
				: undefined,
		onImportLocalPdf:
			isPapersRootMenu && vaultPath
				? () => {
						setMenu(null);
						void importLocalPdf();
					}
				: undefined,
		onImportReview:
			isReviewsRootMenu && vaultPath
				? () => {
						setMenu(null);
						void importReviewFiles(vaultPath).then((units) => {
							if (units[0]) openReviewUnit(units[0]);
						});
					}
				: undefined,
		onAddToChat:
			!targetIsVirtual &&
			menu.path &&
			!menu.path.startsWith(`${VIRTUAL_PATH_PREFIX}`)
				? () => {
						setMenu(null);
						broadcastAgentAttachContext([menu.path]);
					}
				: undefined,
		onNewFile:
			onStartCreate && vaultPath && !managedPaper && !managedReview
				? () => {
						const parent = resolveCreateParent(vaultPath, menu.path, nodes);
						setMenu(null);
						onStartCreate("file", parent);
					}
				: undefined,
		onNewFolder:
			onStartCreate && vaultPath && !managedPaper && !managedReview
				? () => {
						const parent = resolveCreateParent(vaultPath, menu.path, nodes);
						setMenu(null);
						onStartCreate("folder", parent);
					}
				: undefined,
		onNewReview:
			onStartCreate && isReviewsRootMenu
				? () => {
						setMenu(null);
						onStartCreate("review", menu.path);
					}
				: undefined,
		onCopyPath: () => copyPath(menu.path),
		onCut:
			onCutPaths &&
			!targetIsVirtual &&
			!hasProtectedRootTarget &&
			!hasManagedTarget
				? () => {
						setMenu(null);
						onCutPaths(targets);
					}
				: undefined,
		onPaste: onPasteInto
			? () => {
					setMenu(null);
					onPasteInto(menu.path);
				}
			: undefined,
		onReveal: () => reveal(menu.path),
		onOpenInTerminal: () => openTerminal(menu.path),
		onMove:
			onMoveTo && !hasProtectedRootTarget && !hasManagedTarget
				? () => {
						const anchor = { x: menu.x, y: menu.y };
						setMenu(null);
						openMovePicker(targets, anchor);
					}
				: undefined,
		onRename:
			onStartRename &&
			!hasProtectedRootTarget &&
			!isPaperMenu &&
			(!managedPaper || isReviewMenu)
				? () => {
						setMenu(null);
						onStartRename(menu.path);
					}
				: undefined,
		onDelete:
			(onDeletePath || onDeletePaths) && !hasProtectedRootTarget
				? () => {
						setMenu(null);
						if (targets.length > 1 && onDeletePaths)
							void onDeletePaths(targets);
						else if (onDeletePath && targets[0]) void onDeletePath(targets[0]);
					}
				: undefined,
	};

	return { menuProps, revealError, handleContextMenuPath };
}
