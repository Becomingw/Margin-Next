import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Check,
	Copy,
	ExternalLink,
	FolderOpen,
	Loader2,
	Plus,
	RefreshCw,
	Search,
	Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ObjectIcon } from "@/components/icons/object-icon";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { commands, type PoolPaper } from "@/lib/core/bindings";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess, notifyWarning } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { refreshLibrary } from "@/lib/paper/library-store";
import {
	paperPoolStore,
	poolLibraryIndex,
	poolPaperInLibrary,
	poolPaperSearchText,
	refreshPaperPool,
} from "@/lib/plaza/paper-pool";
import { patchSettings } from "@/lib/settings/react-store";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { getVaultPath } from "@/lib/vault/store";

function affiliations(paper: PoolPaper): string {
	return [...new Set(paper.authors.flatMap((a) => a.affiliations ?? []))].join(
		" · ",
	);
}

export function PaperPoolView({ className }: { className?: string }) {
	const { t } = useTranslation(["sidebar", "common"]);
	const source = useSettings((s) => s.paperPoolLocation);
	const vault = useVaultStore((s) => s.vaultPath);
	const library = useLibraryStore((s) => s.papers);
	const pool = useStore(paperPoolStore);
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);
	const libraryIndex = useMemo(() => poolLibraryIndex(library), [library]);
	const [selected, setSelected] = useState<PoolPaper | null>(null);
	const [configOpen, setConfigOpen] = useState(false);
	const [draft, setDraft] = useState(source);
	const [example, setExample] = useState("");
	const [saving, setSaving] = useState(false);
	const [busy, setBusy] = useState<Set<string>>(() => new Set());
	const inFlight = useRef(new Set<string>());
	const owner = useRef({ vault, source });
	owner.current = { vault, source };
	const scroll = useRef<HTMLDivElement>(null);
	const canImport = Boolean(vault && isTauri() && !isRemoteVaultHandle(vault));
	const snapshot = pool.source === source ? pool.snapshot : null;
	useOverlayRegistration("paper-pool-details", Boolean(selected), () =>
		setSelected(null),
	);
	useOverlayRegistration("paper-pool-source", configOpen, () => {
		if (!saving) setConfigOpen(false);
	});
	useEffect(() => {
		setSelected(null);
		if (!isTauri()) return;
		let cancelled = false;
		const state = paperPoolStore.getState();
		if (state.source !== source || !state.snapshot)
			void refreshPaperPool(source).catch((error) => {
				if (!cancelled) notifyError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [source]);
	useEffect(() => {
		if (snapshot?.warnings.length)
			notifyWarning(t("plaza.paperPool.skipped"), {
				description: snapshot.warnings.slice(0, 3).join("\n"),
			});
	}, [snapshot, t]);
	const refresh = async () => {
		try {
			await refreshPaperPool(source);
		} catch (error) {
			notifyError(errorText(error));
		}
	};
	const configure = () => {
		setDraft(source || snapshot?.location || "");
		setConfigOpen(true);
		void commands
			.paperPoolExample()
			.then(setExample)
			.catch((error) => notifyError(errorText(error)));
	};
	const saveSource = async () => {
		if (saving) return;
		setSaving(true);
		try {
			const result = await callApi(() => commands.paperPoolRead(draft.trim()));
			patchSettings({ paperPoolLocation: result.location });
			setConfigOpen(false);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setSaving(false);
		}
	};
	const browse = async () => {
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const path = await open({ directory: true, multiple: false });
			if (typeof path === "string") setDraft(path);
		} catch (error) {
			notifyError(errorText(error));
		}
	};
	const promote = async (paper: PoolPaper) => {
		if (!vault || !canImport || inFlight.current.has(paper.key)) return;
		const target = vault;
		const origin = source;
		inFlight.current.add(paper.key);
		setBusy(new Set(inFlight.current));
		try {
			const result = await callApi(async () => {
				const result = await commands.paperPoolPromote(
					origin,
					paper.key,
					target,
				);
				if (!result.ok && result.error?.code === "pool_candidate_changed")
					throw new Error(t("plaza.paperPool.candidateChanged"));
				return result;
			});
			if (getVaultPath() === target) await refreshLibrary();
			if (owner.current.vault === target && owner.current.source === origin)
				notifySuccess(
					t(
						result.created
							? "plaza.paperPool.promoted"
							: "plaza.paperPool.alreadyImported",
						{ title: result.title },
					),
				);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			inFlight.current.delete(paper.key);
			setBusy(new Set(inFlight.current));
		}
	};
	const indexed = useMemo(
		() =>
			(snapshot?.papers ?? []).map((paper) => ({
				paper,
				search: poolPaperSearchText(paper),
			})),
		[snapshot],
	);
	const visible = useMemo(
		() =>
			indexed
				.filter(
					(row) =>
						row.search.includes(query.trim().toLocaleLowerCase()) &&
						(showAll || !poolPaperInLibrary(row.paper, libraryIndex)),
				)
				.map((row) => row.paper),
		[indexed, query, showAll, libraryIndex],
	);
	const virtual = useVirtualizer({
		count: visible.length,
		getScrollElement: () => scroll.current,
		estimateSize: () => 88,
		overscan: 8,
		getItemKey: (i) => visible[i].key,
	});
	const rows = virtual.getVirtualItems();
	const action = (paper: PoolPaper) =>
		poolPaperInLibrary(paper, libraryIndex) ? (
			<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
				<Check className="size-3.5" />
				{t("plaza.paperPool.imported")}
			</span>
		) : (
			<Button
				size="sm"
				variant="outline"
				disabled={!canImport || busy.has(paper.key)}
				onClick={() => void promote(paper)}
				title={!canImport ? t("plaza.paperPool.needsVault") : undefined}
			>
				{busy.has(paper.key) ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<Plus className="size-3.5" />
				)}
				{t("plaza.paperPool.promote")}
			</Button>
		);
	return (
		<div
			className={cn(
				"@container/paper-page flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
				className,
			)}
		>
			<header className="workbench-toolbar flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-3 @2xl/paper-page:px-4">
				<ObjectIcon kind="paperPool" className="size-4" />
				<h1 className="font-medium text-base">{t("plaza.paperPool.title")}</h1>
				<span className="text-xs text-muted-foreground">
					{t("plaza.paperPool.count", { count: visible.length })}
				</span>
				<Button
					size="sm"
					variant={showAll ? "secondary" : "ghost"}
					aria-pressed={showAll}
					onClick={() => setShowAll((value) => !value)}
				>
					{t("plaza.paperPool.showImported")}
				</Button>
				<div className="relative order-last w-full min-w-0 @2xl/paper-page:order-none @2xl/paper-page:ml-auto @2xl/paper-page:w-56">
					<Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
					<Input
						className="h-8 pl-7"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						aria-label={t("plaza.paperPool.search")}
						placeholder={t("plaza.paperPool.search")}
					/>
				</div>
				<Button
					size="icon-sm"
					variant="ghost"
					disabled={!isTauri() || pool.loading}
					aria-label={t("plaza.paperPool.refresh")}
					title={t("plaza.paperPool.refresh")}
					onClick={() => void refresh()}
				>
					<RefreshCw className={cn("size-4", pool.loading && "animate-spin")} />
				</Button>
				<Button
					size="icon-sm"
					variant="ghost"
					disabled={!isTauri()}
					aria-label={t("plaza.paperPool.configure")}
					title={t("plaza.paperPool.configure")}
					onClick={configure}
				>
					<Settings2 className="size-4" />
				</Button>
			</header>
			<div
				ref={scroll}
				className="edda-scroll-both min-h-0 min-w-0 flex-1 overflow-auto"
			>
				{!visible.length ? (
					<div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
						{pool.loading ? (
							<Loader2 className="size-5 animate-spin" />
						) : (
							<ObjectIcon kind="paperPool" className="size-8" />
						)}
						<p>
							{t(
								pool.loading
									? "plaza.paperPool.loading"
									: query
										? "plaza.paperPool.noMatches"
										: pool.error
											? "plaza.paperPool.loadFailed"
											: snapshot?.papers.length && !showAll
												? "plaza.paperPool.allImported"
												: "plaza.paperPool.empty",
							)}
						</p>
						{!query && !pool.loading && !snapshot?.papers.length && (
							<Button
								variant="outline"
								size="sm"
								onClick={configure}
								disabled={!isTauri()}
							>
								{t("plaza.paperPool.configure")}
							</Button>
						)}
					</div>
				) : (
					<table className="paper-responsive-table paper-pool-table w-full table-fixed text-left text-sm">
						<colgroup>
							<col className="w-[22%]" />
							<col className="w-[14%]" />
							<col className="w-[14%]" />
							<col className="w-[18%]" />
							<col className="w-[18%]" />
							<col className="w-[14%]" />
						</colgroup>
						<thead className="sticky top-0 z-10 bg-background">
							<tr className="h-9 border-b text-xs text-muted-foreground">
								{(
									[
										"title",
										"authors",
										"affiliations",
										"abstract",
										"recommendation",
										"identifier",
									] as const
								).map((key) => (
									<th key={key} data-column={key} className="px-3 font-medium">
										{t(`plaza.paperPool.columns.${key}`)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows[0]?.start ? (
								<tr aria-hidden>
									<td colSpan={6} style={{ height: rows[0].start }} />
								</tr>
							) : null}
							{rows.map((row) => {
								const paper = visible[row.index];
								const authors = paper.authors.map((a) => a.name).join(", ");
								const units = affiliations(paper);
								return (
									<tr
										key={paper.key}
										data-index={row.index}
										ref={virtual.measureElement}
										className="border-b border-hairline-soft hover:bg-muted/40"
									>
										<td data-column="title" className="px-3 py-3 align-top">
											<button
												type="button"
												className="line-clamp-2 break-words text-left font-medium hover:underline focus-visible:ring-1 focus-visible:ring-ring"
												onClick={() => setSelected(paper)}
											>
												{paper.title}
											</button>
											<div className="mt-2">{action(paper)}</div>
										</td>
										<td
											data-label={t("plaza.paperPool.columns.authors")}
											className="px-3 py-3 align-top text-xs"
										>
											<p className="line-clamp-2" title={authors}>
												{authors || "—"}
											</p>
											<span className="text-muted-foreground">
												{paper.year ?? ""}
											</span>
										</td>
										<td
											data-label={t("plaza.paperPool.columns.affiliations")}
											className="px-3 py-3 align-top text-xs text-muted-foreground"
										>
											<p className="line-clamp-3" title={units}>
												{units || "—"}
											</p>
										</td>
										<td
											data-column="abstract"
											data-label={t("plaza.paperPool.columns.abstract")}
											className="px-3 py-3 align-top text-xs text-muted-foreground"
										>
											<p className="line-clamp-3">{paper.abstract || "—"}</p>
										</td>
										<td
											data-column="recommendation"
											data-label={t("plaza.paperPool.columns.recommendation")}
											className="px-3 py-3 align-top text-xs"
										>
											<p className="line-clamp-3">
												{paper.recommendations.map((r) => r.reason).join("\n")}
											</p>
											<p className="mt-1 truncate text-muted-foreground">
												{[
													...new Set(
														paper.recommendations
															.map((r) => r.source)
															.filter(Boolean),
													),
												].join(" · ")}
											</p>
										</td>
										<td
											data-column="identifier"
											data-label={t("plaza.paperPool.columns.identifier")}
											className="break-all px-3 py-3 align-top font-mono text-xs text-muted-foreground"
										>
											{paper.doi || paper.arxivId || "—"}
										</td>
									</tr>
								);
							})}
							{rows.length > 0 && (
								<tr aria-hidden>
									<td
										colSpan={6}
										style={{
											height: virtual.getTotalSize() - (rows.at(-1)?.end ?? 0),
										}}
									/>
								</tr>
							)}
						</tbody>
					</table>
				)}
			</div>
			<Dialog
				open={Boolean(selected)}
				onOpenChange={(open) => {
					if (!open) setSelected(null);
				}}
			>
				<DialogContent
					className="flex max-h-[85dvh] min-h-0 min-w-0 flex-col overflow-hidden sm:max-w-3xl"
					aria-describedby={undefined}
				>
					<DialogHeader>
						<DialogTitle className="break-words pr-5 leading-relaxed">
							{selected?.title}
						</DialogTitle>
					</DialogHeader>
					{selected && (
						<>
							<div className="edda-scroll min-h-0 min-w-0 space-y-5 overflow-auto break-words text-sm">
								<section>
									<h2 className="mb-2 font-medium">
										{t("plaza.paperPool.columns.authors")}
									</h2>
									{selected.authors.map((a) => (
										<p
											key={`${a.name}:${(a.affiliations ?? []).join("|")}`}
											className="mb-1 break-words"
										>
											{a.name}
											{(a.affiliations?.length ?? 0) > 0 && (
												<span className="ml-2 text-muted-foreground">
													{a.affiliations?.join(" · ")}
												</span>
											)}
										</p>
									))}
								</section>
								<section>
									<h2 className="mb-2 font-medium">
										{t("plaza.paperPool.columns.abstract")}
									</h2>
									<p className="whitespace-pre-wrap leading-relaxed">
										{selected.abstract || "—"}
									</p>
								</section>
								<section>
									<h2 className="mb-2 font-medium">
										{t("plaza.paperPool.columns.recommendation")}
									</h2>
									{selected.recommendations.map((r) => (
										<div
											key={`${r.source}:${r.reason}`}
											className="mb-3 rounded-lg bg-muted/50 p-3"
										>
											<p className="mb-1 text-xs text-muted-foreground">
												{r.source || t("plaza.paperPool.externalSource")}
												{r.recommendedAt
													? ` · ${r.recommendedAt.slice(0, 10)}`
													: ""}
											</p>
											<p className="whitespace-pre-wrap leading-relaxed">
												{r.reason}
											</p>
										</div>
									))}
								</section>
								{(selected.doi || selected.arxivId) && (
									<p className="break-all font-mono text-xs text-muted-foreground">
										{[selected.doi, selected.arxivId]
											.filter(Boolean)
											.join(" · ")}
									</p>
								)}
							</div>
							<DialogFooter>
								{(selected.url || selected.doi || selected.arxivId) && (
									<Button
										variant="ghost"
										onClick={() =>
											openExternalUrl(
												selected.url ||
													(selected.doi
														? `https://doi.org/${selected.doi}`
														: `https://arxiv.org/abs/${selected.arxivId}`),
											)
										}
									>
										<ExternalLink className="size-3.5" />
										{t("plaza.paperPool.openSource")}
									</Button>
								)}
								{action(selected)}
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
			<Dialog
				open={configOpen}
				onOpenChange={(open) => {
					if (!saving) setConfigOpen(open);
				}}
			>
				<DialogContent className="max-h-[85dvh] min-w-0 overflow-auto sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{t("plaza.paperPool.configure")}</DialogTitle>
						<DialogDescription>
							{t("plaza.paperPool.storageHint")}
						</DialogDescription>
					</DialogHeader>
					<div className="flex min-w-0 gap-2">
						<Input
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							aria-label={t("plaza.paperPool.location")}
							placeholder={t("plaza.paperPool.location")}
							disabled={saving}
						/>
						<Button
							variant="outline"
							size="icon"
							title={t("plaza.paperPool.browse")}
							aria-label={t("plaza.paperPool.browse")}
							disabled={saving}
							onClick={() => void browse()}
						>
							<FolderOpen className="size-4" />
						</Button>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={!example}
							onClick={() => void copyTextToClipboard(example)}
						>
							<Copy className="size-3.5" />
							{t("plaza.paperPool.copyExample")}
						</Button>
					</div>
					{example && (
						<pre className="edda-scroll min-w-0 max-w-full max-h-64 overflow-auto rounded-lg bg-muted/50 p-3 text-xs">
							{example}
						</pre>
					)}
					<DialogFooter>
						<Button
							variant="ghost"
							disabled={saving}
							onClick={() => setConfigOpen(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button disabled={saving} onClick={() => void saveSource()}>
							{saving && <Loader2 className="size-3.5 animate-spin" />}
							{t("common:save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
