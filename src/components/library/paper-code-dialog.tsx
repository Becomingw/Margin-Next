import { openUrl } from "@tauri-apps/plugin-opener";
import {
	ArrowLeft,
	Download,
	ExternalLink,
	FolderOpen,
	Loader2,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CodeSnapshot, PaperCode } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import {
	importPaperCode,
	inspectPaperCode,
	listCodeFiles,
	readCodeFile,
} from "@/lib/paper/code";
import { trashPathsAndNotify } from "@/lib/vault/actions";
import { joinVaultPath } from "@/lib/vault/path";
import { revealInFileManager } from "@/lib/vault/reveal";
import { getVaultPath, refreshTree } from "@/lib/vault/store";

export function PaperCodeDialog({
	vault,
	path,
	title,
	onClose,
}: {
	vault: string;
	path: string;
	title: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const [data, setData] = useState<PaperCode | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [url, setUrl] = useState("");
	const [selected, setSelected] = useState<CodeSnapshot | null>(null);
	const mounted = useRef(true);
	const loadGeneration = useRef(0);
	const running = useRef(false);
	const load = useCallback(async () => {
		const generation = ++loadGeneration.current;
		setLoading(true);
		try {
			const next = await inspectPaperCode(vault, path);
			if (mounted.current && loadGeneration.current === generation)
				setData(next);
		} catch (error) {
			if (mounted.current && loadGeneration.current === generation)
				notifyError(errorText(error));
		} finally {
			if (mounted.current && loadGeneration.current === generation)
				setLoading(false);
		}
	}, [vault, path]);
	useEffect(() => {
		mounted.current = true;
		void load();
		return () => {
			mounted.current = false;
		};
	}, [load]);

	async function download(source: string) {
		if (running.current) return;
		running.current = true;
		setBusy(true);
		try {
			await importPaperCode(vault, path, source);
			if (getVaultPath() === vault) await refreshTree(vault);
			if (mounted.current) {
				setUrl("");
				await load();
				notifySuccess(t("paperCode.imported"));
			}
		} catch (error) {
			if (mounted.current) notifyError(errorText(error));
		} finally {
			running.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	async function remove(snapshot: CodeSnapshot) {
		if (running.current || getVaultPath() !== vault) return;
		running.current = true;
		setBusy(true);
		try {
			await trashPathsAndNotify([
				joinVaultPath(vault, `${path}/code/${snapshot.id}`),
			]);
			if (mounted.current) await load();
		} catch (error) {
			if (mounted.current) notifyError(errorText(error));
		} finally {
			running.current = false;
			if (mounted.current) setBusy(false);
		}
	}
	const installed = new Set(data?.snapshots.map((s) => s.url.toLowerCase()));
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent
				className="flex max-h-[85dvh] min-h-0 flex-col sm:max-w-3xl"
				showCloseButton={!busy}
			>
				<DialogHeader className="min-w-0 pr-8">
					<DialogTitle>{t("paperCode.title")}</DialogTitle>
					<DialogDescription className="truncate" title={title}>
						{title}
					</DialogDescription>
				</DialogHeader>
				{selected ? (
					<>
						<div className="flex min-w-0 items-center gap-2">
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label={t("paperCode.back")}
								onClick={() => setSelected(null)}
							>
								<ArrowLeft className="size-4" />
							</Button>
							<span className="min-w-0 flex-1 truncate text-xs">
								{selected.url}
							</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								{t("paperCode.readOnly")}
							</span>
						</div>
						<CodeBrowser
							key={selected.id}
							vault={vault}
							path={path}
							snapshot={selected}
						/>
					</>
				) : (
					<>
						<p className="text-muted-foreground text-xs">
							{t("paperCode.hint")}
						</p>
						<form
							className="flex gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								if (url.trim()) void download(url.trim());
							}}
						>
							<Input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								aria-label={t("paperCode.url")}
								placeholder={t("paperCode.url")}
								disabled={busy}
							/>
							<Button
								type="submit"
								variant="outline"
								disabled={busy || !url.trim()}
							>
								<Download className="size-4" />
								{t("paperCode.download")}
							</Button>
						</form>
						<div className="min-h-0 space-y-5 overflow-y-auto overscroll-contain">
							<section className="space-y-2">
								<div className="flex items-center justify-between">
									<h3 className="font-medium text-xs">
										{t("paperCode.candidates")}
									</h3>
									<Button
										size="icon-sm"
										variant="ghost"
										disabled={busy || loading}
										aria-label={t("paperCode.refresh")}
										onClick={() => void load()}
									>
										<RefreshCw className="size-3.5" />
									</Button>
								</div>
								{loading ? (
									<p className="text-muted-foreground text-xs" role="status">
										{t("paperCode.loading")}
									</p>
								) : !data?.candidates.length ? (
									<p className="text-muted-foreground text-xs">
										{t(
											data?.bodyAvailable
												? "paperCode.noCandidates"
												: "paperCode.noBody",
										)}
									</p>
								) : (
									data.candidates.map((candidate) => (
										<div
											key={candidate.url}
											className="flex items-center gap-3 rounded-md border p-3"
										>
											<p className="min-w-0 flex-1 break-all font-medium text-xs">
												{candidate.url}
											</p>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={t("paperCode.openSource")}
												onClick={() =>
													void openUrl(candidate.url).catch((error) =>
														notifyError(errorText(error)),
													)
												}
											>
												<ExternalLink className="size-3.5" />
											</Button>
											<Button
												variant="outline"
												size="sm"
												disabled={
													busy || installed.has(candidate.url.toLowerCase())
												}
												onClick={() => void download(candidate.url)}
											>
												{t(
													installed.has(candidate.url.toLowerCase())
														? "paperCode.saved"
														: "paperCode.download",
												)}
											</Button>
										</div>
									))
								)}
								{data?.truncated ? (
									<p className="text-muted-foreground text-xs">
										{t("paperCode.scanLimited")}
									</p>
								) : null}
							</section>
							<section className="space-y-2">
								<h3 className="font-medium text-xs">
									{t("paperCode.snapshots")}
								</h3>
								{!data?.snapshots.length ? (
									<p className="text-muted-foreground text-xs">
										{t("paperCode.noSnapshots")}
									</p>
								) : (
									data.snapshots.map((snapshot) => (
										<div key={snapshot.id} className="rounded-md border p-3">
											<div className="flex items-start gap-2">
												<div className="min-w-0 flex-1">
													<p className="break-all font-medium text-xs">
														{snapshot.url}
													</p>
													<p className="mt-1 text-muted-foreground text-xs">
														{snapshot.revision.slice(0, 12)} ·{" "}
														{t("paperCode.fileCount", {
															count: snapshot.fileCount,
														})}{" "}
														· {(snapshot.bytes / 1024 / 1024).toFixed(1)} MB
													</p>
													<p className="mt-1 text-muted-foreground text-xs">
														{new Date(snapshot.importedAt).toLocaleString()}
													</p>
												</div>
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={() => setSelected(snapshot)}
												>
													{t("paperCode.browse")}
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													disabled={busy}
													aria-label={t("paperCode.reveal")}
													onClick={() =>
														void revealInFileManager(
															joinVaultPath(
																vault,
																`${path}/code/${snapshot.id}/files`,
															),
														).catch((error) => notifyError(errorText(error)))
													}
												>
													<FolderOpen className="size-3.5" />
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													disabled={busy}
													aria-label={t("paperCode.remove")}
													onClick={() => void remove(snapshot)}
												>
													<Trash2 className="size-3.5" />
												</Button>
											</div>
											{snapshot.skippedEntries > 0 ? (
												<p className="mt-2 text-muted-foreground text-xs">
													{t("paperCode.skipped", {
														count: snapshot.skippedEntries,
													})}
												</p>
											) : null}
										</div>
									))
								)}
							</section>
						</div>
						{busy ? (
							<p
								role="status"
								className="flex items-center gap-2 text-muted-foreground text-xs"
							>
								<Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
								{t("paperCode.working")}
							</p>
						) : null}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CodeBrowser({
	vault,
	path,
	snapshot,
}: {
	vault: string;
	path: string;
	snapshot: CodeSnapshot;
}) {
	const { t } = useTranslation("sidebar");
	const [files, setFiles] = useState<string[]>([]);
	const [query, setQuery] = useState("");
	const [file, setFile] = useState("");
	const [text, setText] = useState("");
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void listCodeFiles(vault, path, snapshot.id)
			.then((next) => {
				if (!cancelled) {
					setFiles(next);
					setFile(
						next.find((f) => /^readme(?:\.|$)/i.test(f)) ?? next[0] ?? "",
					);
				}
			})
			.catch((error) => {
				if (!cancelled) notifyError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [vault, path, snapshot.id]);
	useEffect(() => {
		if (!file) return;
		let cancelled = false;
		setLoading(true);
		setText("");
		void readCodeFile(vault, path, snapshot.id, file)
			.then((value) => {
				if (!cancelled) setText(value);
			})
			.catch((error) => {
				if (!cancelled) notifyError(errorText(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [vault, path, snapshot.id, file]);
	const filtered = files.filter((f) =>
		f.toLowerCase().includes(query.toLowerCase()),
	);
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<Input
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				aria-label={t("paperCode.filterFiles")}
				placeholder={t("paperCode.filterFiles")}
			/>
			<div className="grid min-h-0 grid-cols-1 overflow-hidden rounded-md border sm:grid-cols-[12rem_minmax(0,1fr)]">
				<fieldset
					className="max-h-32 overflow-y-auto border-b p-1 sm:max-h-[55dvh] sm:border-r sm:border-b-0"
					aria-label={t("paperCode.files")}
				>
					{filtered.slice(0, 300).map((name) => (
						<button
							type="button"
							key={name}
							onClick={() => setFile(name)}
							title={name}
							aria-pressed={name === file}
							className={`block w-full truncate rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline focus-visible:outline-ring ${name === file ? "bg-accent" : ""}`}
						>
							{name}
						</button>
					))}
					{filtered.length > 300 ? (
						<p className="p-2 text-muted-foreground text-xs">
							{t("paperCode.filterMore")}
						</p>
					) : null}
				</fieldset>
				<div className="min-h-0 min-w-0">
					<p
						className="truncate border-b px-3 py-2 text-muted-foreground text-xs"
						title={file}
					>
						{file || t("paperCode.files")}
					</p>
					<pre className="h-[40dvh] overflow-auto whitespace-pre p-3 font-mono text-xs leading-relaxed sm:h-[50dvh]">
						{loading ? t("paperCode.loading") : text}
					</pre>
				</div>
			</div>
		</div>
	);
}
