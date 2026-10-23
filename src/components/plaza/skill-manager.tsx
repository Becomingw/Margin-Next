import {
	Download,
	FolderOpen,
	Loader2,
	Lock,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SkillImportDialog } from "@/components/dialogs/skill-import-dialog";
import { SkillRecommendations } from "@/components/plaza/plaza-skills-view";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useSettings, useVaultStore } from "@/hooks/use-app-stores";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import {
	commands,
	type ManagedSkill,
	type SkillDiscovery,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess, notifyUndo } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { lifecycle } from "@/lib/lifecycle";
import {
	discardSkillDiscovery,
	installDiscoveredSkills,
} from "@/lib/paper/lookup";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

export function SkillManager({ className }: { className?: string }) {
	const { t } = useTranslation("sidebar");
	const vault = useVaultStore((state) => state.vaultPath);
	// System presets are read-only unless developer mode is on.
	const developerMode = useSettings((state) => state.developerMode);
	const supported = Boolean(vault && isTauri() && !isRemoteVaultHandle(vault));
	const owner = useRef(vault);
	owner.current = vault;
	const generation = useRef(0);
	const scopeEpoch = useRef(0);
	const operation = useRef<number | null>(null);
	const [items, setItems] = useState<ManagedSkill[]>([]);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [tab, setTab] = useState<"installed" | "discover">("installed");
	const [query, setQuery] = useState("");
	const [addOpen, setAddOpen] = useState(false);
	const [source, setSource] = useState("");
	const [discovery, setDiscovery] = useState<{
		vault: string;
		value: SkillDiscovery;
	} | null>(null);
	const staged = useRef<SkillDiscovery | null>(null);
	useOverlayRegistration("skill-source", addOpen, () => {
		if (!busy) setAddOpen(false);
	});
	const reload = useCallback(async () => {
		if (!vault || !supported) return;
		const token = ++generation.current;
		setLoading(true);
		try {
			const next = await callApi(() => commands.agentVaultSkills(vault));
			if (token === generation.current && owner.current === vault)
				setItems(next);
		} catch (error) {
			if (token === generation.current) notifyError(errorText(error));
		} finally {
			if (token === generation.current) setLoading(false);
		}
	}, [vault, supported]);
	useEffect(() => {
		operation.current = null;
		setItems([]);
		setLoading(false);
		setBusy(false);
		setDiscovery(null);
		setAddOpen(false);
		setQuery("");
		void reload();
		const off = lifecycle.on("agent:registry-changed", () => {
			void reload();
		});
		return () => {
			generation.current++;
			scopeEpoch.current++;
			off();
			if (staged.current) {
				void discardSkillDiscovery(staged.current.discoveryId).catch((error) =>
					notifyError(errorText(error)),
				);
				staged.current = null;
			}
		};
	}, [reload]);

	const mutate = async (
		work: (root: string, current: () => boolean) => Promise<void>,
	) => {
		if (!vault || !supported || operation.current !== null) return;
		const root = vault;
		const epoch = scopeEpoch.current;
		operation.current = epoch;
		const current = () =>
			owner.current === root && epoch === scopeEpoch.current;
		setBusy(true);
		try {
			await work(root, current);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			if (current()) {
				operation.current = null;
				setBusy(false);
				await reload();
			}
		}
	};
	const discover = async (url: string) => {
		await mutate(async (root, current) => {
			const result = await callApi(() =>
				commands.agentDiscoverVaultSkill(root, url.trim()),
			);
			if (!current()) {
				await discardSkillDiscovery(result.discoveryId);
				return;
			}
			staged.current = result;
			setDiscovery({ vault: root, value: result });
			setAddOpen(false);
			setSource("");
		});
	};
	const cancelDiscovery = () => {
		if (staged.current)
			void discardSkillDiscovery(staged.current.discoveryId).catch((error) =>
				notifyError(errorText(error)),
			);
		staged.current = null;
		setDiscovery(null);
	};
	const install = async (
		selections: Array<{ discoveryId: string; selectedNames: string[] }>,
	) => {
		if (!discovery || owner.current !== discovery.vault) return;
		await mutate(async (root, current) => {
			staged.current = null;
			setDiscovery(null);
			for (const selection of selections)
				await installDiscoveredSkills({ vaultRoot: root, ...selection });
			if (current()) {
				setTab("installed");
				setQuery("");
			}
		});
	};
	const importFolder = () =>
		void mutate(async (root, current) => {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const path = await open({
				directory: true,
				multiple: false,
				title: t("plaza.skills.selectFolder"),
			});
			if (typeof path !== "string" || !current()) return;
			const result = await callApi(() =>
				commands.agentImportLocalSkill(root, path),
			);
			if (result.skipped) notifySuccess(t("lookup.skillImportInstalled"));
			if (current()) {
				setTab("installed");
				setQuery("");
			}
		});
	const remove = (item: ManagedSkill) =>
		void mutate(async (root) => {
			const result = await callApi(() =>
				commands.agentRemoveVaultSkill(root, item.id),
			);
			notifyUndo(t("plaza.skills.removed", { name: item.name }), {
				actionLabel: t("plaza.skills.undo"),
				onAction: () => {
					void callApi(() =>
						commands.agentRestoreVaultSkill(root, item.id, result.batchId),
					)
						.then(() => {
							if (owner.current === root) void reload();
						})
						.catch((error) => notifyError(errorText(error)));
				},
			});
		});
	const installed = items.filter((item) => item.installed);
	const visible = installed.filter((item) =>
		`${item.name} ${item.id} ${item.description}`
			.toLowerCase()
			.includes(query.trim().toLowerCase()),
	);
	return (
		<div
			aria-busy={busy || loading}
			className={cn(
				"@container/skills edda-scroll h-full min-h-0 min-w-0 w-full overflow-y-auto p-3",
				className,
			)}
		>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 flex-1 basis-48">
					<h1 className="font-medium text-base">{t("plaza.skills.title")}</h1>
					<p className="mt-1 break-all text-muted-foreground text-xs">
						{vault
							? t("plaza.skills.vaultScope", {
									name: vault.split(/[\\/]/).filter(Boolean).pop(),
								})
							: t("lookup.needsVault")}
					</p>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={t("plaza.skills.instructions")}
						title={t("plaza.skills.instructions")}
						onClick={() => openSettingsWindow("agent")}
					>
						<Settings2 className="size-4" />
					</Button>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={t("plaza.skills.refresh")}
						title={t("plaza.skills.refresh")}
						disabled={!supported || loading || busy}
						onClick={() => void reload()}
					>
						<RefreshCw className={cn("size-4", loading && "animate-spin")} />
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="sm" disabled={!supported || busy}>
								<Plus className="size-4" />
								{t("plaza.skills.add")}
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => setAddOpen(true)}>
								<Download className="size-4" />
								{t("plaza.skills.fromLink")}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={importFolder}>
								<FolderOpen className="size-4" />
								{t("plaza.skills.fromFolder")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</header>
			<nav
				className="mt-4 flex flex-wrap gap-1 border-b pb-2"
				aria-label={t("plaza.skills.title")}
			>
				{(["installed", "discover"] as const).map((value) => (
					<Button
						key={value}
						aria-pressed={tab === value}
						size="sm"
						variant={tab === value ? "secondary" : "ghost"}
						onClick={() => setTab(value)}
					>
						{t(`plaza.skills.${value}`)}
						{value === "installed" ? ` (${installed.length})` : ""}
					</Button>
				))}
			</nav>
			{vault && isRemoteVaultHandle(vault) ? (
				<p className="mt-3 text-muted-foreground text-sm">
					{t("plaza.skills.remote")}
				</p>
			) : null}
			{tab === "installed" ? (
				<section className="mt-3">
					<div className="relative mb-3 max-w-sm">
						<Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
						<Input
							className="pl-8"
							aria-label={t("plaza.skills.search")}
							placeholder={t("plaza.skills.search")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					{loading && !items.length ? (
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					) : !visible.length ? (
						<p className="py-6 text-muted-foreground text-sm">
							{t(query ? "plaza.skills.noMatches" : "plaza.skills.empty")}
						</p>
					) : (
						<div className="space-y-2">
							{visible.map((item) => (
								<article
									key={item.id}
									className="workbench-card flex min-w-0 items-start gap-3 rounded-lg border p-3"
								>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<h2
												className="truncate font-medium text-sm"
												title={item.id}
											>
												{item.name}
											</h2>
											{item.bundled && (
												<span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
													{t("plaza.skills.bundled")}
												</span>
											)}
											{item.modified && (
												<span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs text-muted-foreground">
													{t("plaza.skills.modified")}
												</span>
											)}
										</div>
										<p
											title={item.description}
											className="mt-1 line-clamp-2 break-words text-muted-foreground text-xs leading-relaxed"
										>
											{item.valid
												? item.description
												: t("plaza.skills.incomplete")}
										</p>
									</div>
									{item.bundled && !developerMode ? (
										<span
											className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
											role="img"
											aria-label={t("plaza.skills.locked")}
											title={t("plaza.skills.locked")}
										>
											<Lock className="size-3.5" />
										</span>
									) : (
										<Button
											size="icon-sm"
											variant="ghost"
											className="shrink-0 hover:text-destructive"
											disabled={busy}
											aria-label={t("plaza.skills.remove", { name: item.name })}
											title={t("plaza.skills.remove", { name: item.name })}
											onClick={() => remove(item)}
										>
											<Trash2 className="size-4" />
										</Button>
									)}
								</article>
							))}
						</div>
					)}
				</section>
			) : (
				<section>
					{items.some((item) => item.bundled && !item.installed) && (
						<div className="mt-4">
							<h2 className="mb-2 text-muted-foreground text-xs">
								{t("plaza.skills.bundled")}
							</h2>
							<div className="flex flex-wrap gap-2">
								{items
									.filter((item) => item.bundled && !item.installed)
									.map((item) => (
										<Button
											key={item.id}
											variant="outline"
											size="sm"
											disabled={busy || !supported}
											onClick={() =>
												void mutate(async (root) => {
													await callApi(() =>
														commands.agentRestoreVaultSkill(
															root,
															item.id,
															null,
														),
													);
												})
											}
										>
											<Plus className="size-3.5" />
											{item.name}
										</Button>
									))}
							</div>
						</div>
					)}
					<SkillRecommendations
						onImport={discover}
						disabled={busy || !supported}
					/>
				</section>
			)}
			<Dialog
				open={addOpen}
				onOpenChange={(open) => {
					if (!busy) setAddOpen(open);
				}}
			>
				<DialogContent aria-describedby={undefined}>
					<DialogHeader>
						<DialogTitle>{t("plaza.skills.fromLink")}</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void discover(source);
						}}
					>
						<Input
							autoFocus
							value={source}
							onChange={(event) => setSource(event.target.value)}
							aria-label={t("plaza.skills.source")}
							placeholder={t("plaza.skills.source")}
							disabled={busy}
						/>
						<DialogFooter className="mt-4">
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								onClick={() => setAddOpen(false)}
							>
								{t("lookup.skillImportCancel")}
							</Button>
							<Button type="submit" disabled={busy || !source.trim()}>
								{busy && <Loader2 className="size-4 animate-spin" />}
								{t("plaza.skills.find")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<SkillImportDialog
				discoveries={discovery ? [discovery.value] : null}
				onCancel={cancelDiscovery}
				onConfirm={install}
			/>
		</div>
	);
}
