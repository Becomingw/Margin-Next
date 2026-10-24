import { open } from "@tauri-apps/plugin-dialog";
import {
	FilePlus2,
	FileText,
	FolderOpen,
	Import,
	Moon,
	PanelLeft,
	RefreshCw,
	Sun,
	Type,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import marginAppIcon from "@/assets/margin-app-icon.svg";
import { ReviewWorkspace } from "@/components/review/review-workspace";
import type { DocViewEditorProps } from "@/components/workspace/doc-view-types";
import type { ReviewUnitSummary } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import {
	createReview,
	importReviewFiles,
	reloadOpenReview,
} from "@/lib/review/actions";
import { reviewApi as commands } from "@/lib/review/api";
import { reviewStore, setUnits } from "@/lib/review/store";
import { joinVaultPath } from "@/lib/vault";
import { updateTab, workspaceStore } from "@/lib/workspace/store";
import { createPlaceholderTab } from "@/lib/workspace/tabs";
import { stopAi } from "./ai-client";
import { MarginAiDialog } from "./ai-dialog";
import {
	adoptMarginSnapshot,
	readMarginManuscript as readVaultFile,
} from "./api";
import { useNativeFrame } from "./native-frame";
import { marginWorkspace, openMarginWorkspace } from "./workspace";

export function MarginApp() {
	const { t } = useTranslation("margin");
	const { resolvedTheme, setTheme } = useTheme();
	const nativeFrame = useNativeFrame(resolvedTheme);
	const root = useStore(marginWorkspace, (s) => s.root);
	const [sidebar, setSidebar] = useState(true);
	const [toolbar, setToolbar] = useState(false);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [aiBusy, setAiBusy] = useState(false);
	const aiBusyRef = useRef(false);
	const setAiMutationPending = useCallback((value: boolean) => {
		aiBusyRef.current = value;
		setAiBusy(value);
	}, []);
	const generation = useRef(0);
	const units = useStore(reviewStore, (s) => s.units);
	const tab = useStore(workspaceStore, (s) =>
		s.tabs.find((x) => x.id === s.activeTabId),
	);
	const canLeave = useCallback(() => {
		if (
			aiBusyRef.current ||
			workspaceStore.getState().tabs.some((x) => x.markdownDirty)
		) {
			notifyError(t("pending"));
			return false;
		}
		return true;
	}, [t]);
	const refresh = useCallback(async (path: string) => {
		const list = await callApiResult(() => commands.reviewList(path));
		setUnits(list);
	}, []);
	const pickWorkspace = async () => {
		if (!canLeave()) return;
		const picked = await open({ directory: true, multiple: false });
		if (typeof picked !== "string" || !canLeave()) return;
		await openMarginWorkspace(picked);
		generation.current++;
	};
	const openUnit = async (unit: ReviewUnitSummary) => {
		if (!root || !canLeave()) return;
		const tick = ++generation.current;
		await stopAi();
		const path = joinVaultPath(unit.path, "manuscript.md");
		const markdown = await readVaultFile(path);
		if (tick !== generation.current || !canLeave()) return;
		const next = {
			...createPlaceholderTab(path),
			title: unit.title,
			reviewId: unit.id,
			markdownSeed: markdown,
			loaded: true,
		};
		workspaceStore.setState({ tabs: [next], activeTabId: next.id });
	};
	const run = (action: () => Promise<unknown>) => {
		if (busy) return;
		setBusy(true);
		void action()
			.catch((e) => notifyError(errorMessage(e)))
			.finally(() => setBusy(false));
	};
	const editor = useMemo<DocViewEditorProps>(
		() => ({
			fontSize: 16,
			lineHeight: 1.8,
			showToolbar: toolbar,
			notesPlaceholder: "",
			markdownPlaceholder: t("placeholder"),
			onTabPatch: updateTab,
			onAssetsChanged: () => {},
			onPersistFile: async (path, markdown, lastSaved, write) => {
				if (!write) return false;
				try {
					if ((await write(markdown, lastSaved)) === "conflict") {
						notifyError(t("conflict"));
						return false;
					}
					const current = workspaceStore
						.getState()
						.tabs.find((x) => x.path === path);
					if (current) updateTab(current.id, { markdownSeed: markdown });
					return true;
				} catch (e) {
					notifyError(errorMessage(e));
					return false;
				}
			},
		}),
		[toolbar, t],
	);
	useEffect(() => {
		const preventLoss = (event: BeforeUnloadEvent) => {
			if (
				aiBusyRef.current ||
				workspaceStore.getState().tabs.some((x) => x.markdownDirty)
			)
				event.preventDefault();
		};
		window.addEventListener("beforeunload", preventLoss);
		return () => window.removeEventListener("beforeunload", preventLoss);
	}, []);
	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
			const stop = await getCurrentWindow().onCloseRequested((event) => {
				if (!canLeave()) event.preventDefault();
			});
			if (disposed) stop();
			else unlisten = stop;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [canLeave]);
	// No Vault/catalog startup or background network jobs. Poll only the active
	// review's state stamp, including external reviewer writes, while visible.
	useEffect(() => {
		if (!root || !tab?.reviewId) return;
		const id = tab.reviewId;
		const tabId = tab.id;
		let stopped = false;
		let checking = false;
		const timer = window.setInterval(async () => {
			if (stopped || checking || document.visibilityState !== "visible") return;
			checking = true;
			try {
				await reloadOpenReview(root, id);
				const current = workspaceStore
					.getState()
					.tabs.find((x) => x.id === tabId);
				if (!current || current.markdownDirty || stopped) return;
				const snapshot = reviewStore.getState().docs[id];
				if (!snapshot) return;
				const latest = workspaceStore
					.getState()
					.tabs.find((x) => x.id === tabId);
				if (
					!stopped &&
					latest &&
					!latest.markdownDirty &&
					latest.markdownSeed === current.markdownSeed
				) {
					const markdown = adoptMarginSnapshot(root, id, snapshot);
					if (markdown === latest.markdownSeed) return;
					updateTab(tabId, {
						markdownSeed: markdown,
						seedKey: latest.seedKey + 1,
					});
				}
			} catch {
				/* A transient external rename is retried on the next tick. */
			} finally {
				checking = false;
			}
		}, 1500);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [root, tab?.reviewId, tab?.id]);
	const iconButton =
		"inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
	return (
		<div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
			<header
				data-margin-frame
				data-tauri-drag-region={nativeFrame || undefined}
				className={cn(
					"flex h-12 shrink-0 items-center gap-2 border-hairline-soft border-b bg-background px-3",
					nativeFrame && "pr-36",
				)}
			>
				<button
					type="button"
					className={iconButton}
					aria-label={t("workspace")}
					aria-expanded={sidebar}
					onClick={() => setSidebar(!sidebar)}
				>
					<PanelLeft size={16} />
				</button>
				<img
					data-tauri-drag-region={nativeFrame || undefined}
					src={marginAppIcon}
					alt=""
					aria-hidden="true"
					className="size-7 shrink-0"
				/>
				<span
					data-tauri-drag-region={nativeFrame || undefined}
					className="font-semibold text-sm"
				>
					{t("name")}
				</span>
				<span
					data-tauri-drag-region={nativeFrame || undefined}
					className="ml-3 min-w-0 flex-1 truncate text-muted-foreground text-xs"
				>
					{tab?.title}
				</span>
				{tab && (
					<span role="status" className="text-muted-foreground text-xs">
						{t(tab.markdownDirty ? "saving" : "saved")}
					</span>
				)}
				{tab && (
					<button
						type="button"
						className={iconButton}
						aria-label={t("toolbar")}
						title={t("toolbar")}
						aria-pressed={toolbar}
						onClick={() => setToolbar(!toolbar)}
					>
						<Type size={16} />
					</button>
				)}
				{root && tab?.reviewId ? (
					<MarginAiDialog
						key={`${root}:${tab.reviewId}`}
						root={root}
						reviewId={tab.reviewId}
						onBusyChange={setAiMutationPending}
					/>
				) : null}
				<button
					type="button"
					className={iconButton}
					aria-label={t("theme")}
					title={t("theme")}
					onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
				>
					{resolvedTheme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
				</button>
			</header>
			<div className="flex min-h-0 flex-1">
				{sidebar && (
					<aside
						aria-label={t("workspace")}
						className="flex w-60 shrink-0 flex-col gap-3 border-hairline-soft border-r bg-sidebar p-3"
					>
						<button
							type="button"
							disabled={busy || !isTauri()}
							className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent disabled:opacity-40"
							onClick={() => run(pickWorkspace)}
						>
							<FolderOpen size={16} />
							{t("open")}
						</button>
						{root && (
							<>
								<div className="flex items-center gap-1">
									<button
										type="button"
										title={t("new")}
										aria-label={t("new")}
										disabled={busy}
										className={iconButton}
										onClick={() =>
											run(async () => {
												if (!canLeave()) return;
												const unit = await createReview(root, t("untitled"));
												if (unit) await openUnit(unit);
											})
										}
									>
										<FilePlus2 size={16} />
									</button>
									<button
										type="button"
										title={t("import")}
										aria-label={t("import")}
										disabled={busy}
										className={iconButton}
										onClick={() =>
											run(async () => {
												if (!canLeave()) return;
												const imported = await importReviewFiles(
													root,
													undefined,
													{ refreshVaultTree: false },
												);
												if (imported[0]) await openUnit(imported[0]);
											})
										}
									>
										<Import size={16} />
									</button>
									<button
										type="button"
										title={t("refresh")}
										aria-label={t("refresh")}
										disabled={busy}
										className={iconButton}
										onClick={() => run(() => refresh(root))}
									>
										<RefreshCw size={16} />
									</button>
								</div>
								<input
									aria-label={t("search")}
									placeholder={t("search")}
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring"
								/>
								<nav className="edda-scroll min-h-0 flex-1 overflow-y-auto">
									{units
										.filter((u) =>
											u.title
												.toLocaleLowerCase()
												.includes(query.toLocaleLowerCase()),
										)
										.map((unit) => (
											<button
												type="button"
												key={unit.id}
												disabled={busy}
												aria-current={
													tab?.reviewId === unit.id ? "page" : undefined
												}
												className={cn(
													"mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
													tab?.reviewId === unit.id && "bg-accent",
												)}
												onClick={() => run(() => openUnit(unit))}
											>
												<FileText
													size={15}
													className="shrink-0 text-muted-foreground"
												/>
												<span className="truncate">{unit.title}</span>
												<span className="ml-auto text-muted-foreground text-xs tabular-nums">
													{unit.openCount || ""}
												</span>
											</button>
										))}
								</nav>
							</>
						)}
					</aside>
				)}
				<main className="flex min-h-0 min-w-0 flex-1 flex-col">
					{root && tab?.reviewId ? (
						<ReviewWorkspace
							key={tab.id}
							tab={tab}
							vaultPath={root}
							reviewId={tab.reviewId}
							editor={editor}
							libraryCitations={false}
							externalMutationPending={aiBusy}
						/>
					) : (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
							<FileText size={32} className="text-muted-foreground" />
							<h1 className="font-medium text-lg">
								{t(root ? "empty" : "welcome")}
							</h1>
							<p className="max-w-sm text-muted-foreground text-sm">
								{t(isTauri() ? "description" : "desktop")}
							</p>
							{isTauri() && !root && (
								<button
									type="button"
									disabled={busy}
									className="mt-2 h-9 rounded-md bg-primary px-4 text-primary-foreground text-sm"
									onClick={() => run(pickWorkspace)}
								>
									{t("open")}
								</button>
							)}
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
