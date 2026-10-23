import { ChevronRight, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ProviderCard,
	ProviderField,
} from "@/components/settings/provider-card";
import {
	HelpLabel,
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import {
	type ProbeStatus,
	probeTone,
	TooltipDot,
} from "@/components/settings/status-dot";
import type { SettingsHostContext } from "@/components/settings/types";
import { useBuiltinProviderAvailable } from "@/components/settings/use-builtin-provider";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { BUILTIN_PROVIDER_ID } from "@/lib/core/builtin";
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import {
	clearAndReparse,
	clearParseResults,
	type ParseResultScope,
} from "@/lib/paper/reparse";
import {
	layoutBackendsAfterClearingProvider,
	persistLayoutProviderConfig,
	probeLayoutProvider,
} from "@/lib/pdf/layout/provider-config";
import {
	isProviderCardConfigurable,
	isRemoteLayoutProvider,
	LAYOUT_PROVIDERS,
	layoutProviderCard,
	mergeProviderCards,
	PARSER_PROVIDERS,
	type ProviderCardDescriptor,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_MINERU_LANGUAGE,
	isLayoutBackend,
	isParserBackend,
	LAYOUT_PROVIDER_DEFAULT_BASE_URLS,
	LAYOUT_PROVIDER_DOCS_URLS,
	type LayoutProviderConfig,
	type LayoutProviderId,
	MINERU_LANGUAGES,
	PARSER_BACKENDS,
	PROVIDER_MODEL_PRESETS,
} from "@/lib/pdf/layout/settings";
import type { AppSettings } from "@/lib/settings";

const EMPTY_PROVIDER_CONFIG: LayoutProviderConfig = {
	apiKey: "",
	baseUrl: "",
	model: "",
	prompt: "",
	language: DEFAULT_MINERU_LANGUAGE,
	isOcr: false,
};

function probeStatusLabelKey(status: ProbeStatus): string {
	switch (status) {
		case "ok":
			return "layout.providerConfig.probeOk";
		case "fail":
			return "layout.providerConfig.probeFail";
		case "probing":
			return "layout.providerConfig.probeProbing";
		default:
			return "layout.providerConfig.probeIdle";
	}
}

export function LayoutPane({
	settings,
	patch,
	vaultPath,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	vaultPath?: string | null;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const layout = settings.layout;
	const builtinAvailable = useBuiltinProviderAvailable();
	const isLocalVault = hostContext.kind === "local";
	const canManageResults = Boolean(vaultPath) && isLocalVault && isTauri();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogMode, setDialogMode] = useState<"clear" | "reparse">("clear");
	const [scope, setScope] = useState<ParseResultScope>("all");
	const [busy, setBusy] = useState(false);
	const isProviderConfigured = (id: LayoutProviderId) =>
		(layout.providerConfigs[id]?.apiKey ?? "").trim().length > 0;
	// All remote providers are listed for configuration, like the translate
	// pane; the backend selects only offer the configured ones (plus local).
	// Cards with no editable field (the built-in parser) render nothing.
	const cards = mergeProviderCards([
		...Object.values(LAYOUT_PROVIDERS).map((descriptor) =>
			layoutProviderCard(descriptor),
		),
		...Object.values(PARSER_PROVIDERS),
	]).filter(isProviderCardConfigurable);
	const backendOptions = Object.values(LAYOUT_PROVIDERS).filter(
		(descriptor) => {
			if (!isRemoteLayoutProvider(descriptor)) return true;
			if (descriptor.id === layout.backend) return true;
			return isProviderConfigured(descriptor.id);
		},
	);
	const parserBackendOptions = PARSER_BACKENDS.filter((backend) => {
		if (backend === "local") return true;
		// The built-in parser has no apiKey, so it is exempt from the configured
		// check like `local`; gate it on Host availability, keeping a carried-over
		// selection visible so it renders disabled rather than vanishing.
		if (backend === BUILTIN_PROVIDER_ID) {
			return builtinAvailable || backend === layout.parserBackend;
		}
		return backend === layout.parserBackend || isProviderConfigured(backend);
	});

	const openDialog = useCallback((mode: "clear" | "reparse") => {
		setDialogMode(mode);
		setScope("all");
		setDialogOpen(true);
	}, []);

	const handleConfirm = useCallback(async () => {
		if (!vaultPath) return;
		setBusy(true);
		try {
			const result =
				dialogMode === "clear"
					? await clearParseResults(vaultPath, scope)
					: await clearAndReparse(vaultPath, scope);
			notifySuccess(
				t(
					dialogMode === "clear"
						? "layout.clearResults.clearDone"
						: "layout.clearResults.reparseDone",
					{
						scanned: result.papersScanned,
						removed: result.filesRemoved,
						layout: "layoutEnqueued" in result ? result.layoutEnqueued : 0,
						paper: "paperEnqueued" in result ? result.paperEnqueued : 0,
					},
				),
			);
			setDialogOpen(false);
		} catch (err) {
			notifyError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	}, [dialogMode, scope, vaultPath, t]);

	// Providers not in use stay collapsed until opened.
	const [expandedProviders, setExpandedProviders] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const toggleProvider = (id: string) =>
		setExpandedProviders((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const confirmLabel =
		dialogMode === "clear"
			? t("layout.clearResults.confirmClear")
			: t("layout.clearResults.confirmReparse");

	return (
		<>
			<PageTitle title={t("layout.title")} />

			<SettingsGroup>
				<SettingsRow label={t("layout.backend.label")} htmlFor="layout-backend">
					<Select
						value={layout.backend}
						disabled={backendOptions.length <= 1}
						onValueChange={(value) => {
							if (isLayoutBackend(value)) {
								patch({ layout: { ...layout, backend: value } });
							}
						}}
					>
						<SelectTrigger
							id="layout-backend"
							size="sm"
							className={cn(
								"min-w-[200px] max-w-[280px]",
								// Keep full opacity when the sole option is locked — avoids
								// a washed-out look and width jump vs plain text.
								backendOptions.length <= 1 &&
									"disabled:cursor-default disabled:opacity-100",
							)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{backendOptions.map((descriptor) => (
								<SelectItem key={descriptor.id} value={descriptor.id}>
									{t(
										`layout.backend.${descriptor.id}` as "layout.backend.local",
									)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("layout.parserBackend.label")}
					htmlFor="layout-parser-backend"
				>
					<Select
						value={layout.parserBackend}
						disabled={parserBackendOptions.length <= 1}
						onValueChange={(value) => {
							if (isParserBackend(value)) {
								patch({ layout: { ...layout, parserBackend: value } });
							}
						}}
					>
						<SelectTrigger
							id="layout-parser-backend"
							size="sm"
							className={cn(
								"min-w-[200px] max-w-[280px]",
								parserBackendOptions.length <= 1 &&
									"disabled:cursor-default disabled:opacity-100",
							)}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{parserBackendOptions.map((backend) => (
								<SelectItem
									key={backend}
									value={backend}
									disabled={
										backend === BUILTIN_PROVIDER_ID && !builtinAvailable
									}
								>
									{t(
										`layout.parserBackend.${backend}` as "layout.parserBackend.local",
									)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>

			<div className="mb-5">
				<SettingsSectionLabel>
					{t("layout.providerConfig.section")}
				</SettingsSectionLabel>
				<div className="grid gap-2">
					{cards.map((card) => (
						<ProviderConfigCard
							key={card.id}
							provider={card}
							settings={settings}
							patch={patch}
							open={
								card.id === layout.backend ||
								card.id === layout.parserBackend ||
								expandedProviders.has(card.id)
							}
							onToggle={() => toggleProvider(card.id)}
						/>
					))}
				</div>
			</div>

			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!canManageResults || busy}
					onClick={() => openDialog("clear")}
				>
					<Trash2 data-icon="inline-start" className="size-3.5" />
					{t("layout.clearResults.clear")}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!canManageResults || busy}
					onClick={() => openDialog("reparse")}
				>
					<RefreshCw data-icon="inline-start" className="size-3.5" />
					{t("layout.clearResults.clearAndReparse")}
				</Button>
			</div>

			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					if (!open && !busy) setDialogOpen(false);
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="sm:max-w-xs"
					aria-describedby={undefined}
				>
					<DialogHeader>
						<DialogTitle>
							{dialogMode === "clear"
								? t("layout.clearResults.dialog.clearTitle")
								: t("layout.clearResults.dialog.reparseTitle")}
						</DialogTitle>
					</DialogHeader>

					<div className="space-y-1.5 py-1">
						<Label className="text-xs text-muted-foreground">
							{t("layout.clearResults.dialog.scopeLabel")}
						</Label>
						<Select
							value={scope}
							onValueChange={(v) => setScope(v as ParseResultScope)}
							disabled={busy}
						>
							<SelectTrigger size="sm" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="layout">
									{t("layout.clearResults.scope.layout")}
								</SelectItem>
								<SelectItem value="paper">
									{t("layout.clearResults.scope.paper")}
								</SelectItem>
								<SelectItem value="all">
									{t("layout.clearResults.scope.all")}
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => setDialogOpen(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							disabled={busy}
							onClick={() => void handleConfirm()}
						>
							{busy
								? dialogMode === "clear"
									? t("layout.clearResults.clearing")
									: t("layout.clearResults.reparsing")
								: confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ProviderConfigCard({
	provider,
	settings,
	patch,
	open,
	onToggle,
}: {
	provider: ProviderCardDescriptor;
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	open: boolean;
	onToggle: () => void;
}) {
	const { t } = useTranslation("settings");
	const providerName = t(
		`layout.providerConfig.providerName.${provider.id}` as "layout.providerConfig.providerName.paddle",
	);
	const layout = settings.layout;
	const stored = layout.providerConfigs[provider.id] ?? EMPTY_PROVIDER_CONFIG;
	const [draft, setDraft] = useState<Partial<LayoutProviderConfig>>({});
	const [status, setStatus] = useState<ProbeStatus>("idle");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const probeAbortRef = useRef<AbortController | null>(null);

	const modelPresets = PROVIDER_MODEL_PRESETS[provider.id] ?? [];
	// Empty stored value means "use the engine default": show that default as
	// the actual input value so the card looks ready to use.
	const defaultModel = modelPresets[0] ?? "";
	const defaultBaseUrl = LAYOUT_PROVIDER_DEFAULT_BASE_URLS[provider.id] ?? "";
	const displayApiKey =
		draft.apiKey !== undefined ? draft.apiKey : stored.apiKey;
	const displayBaseUrl =
		draft.baseUrl !== undefined
			? draft.baseUrl
			: stored.baseUrl || defaultBaseUrl;
	const displayModel =
		draft.model !== undefined ? draft.model : stored.model || defaultModel;
	const displayPrompt =
		draft.prompt !== undefined ? draft.prompt : stored.prompt;
	const displayLanguage =
		draft.language !== undefined
			? draft.language
			: stored.language || DEFAULT_MINERU_LANGUAGE;
	const displayIsOcr = draft.isOcr !== undefined ? draft.isOcr : stored.isOcr;
	const configured = displayApiKey.trim().length > 0;

	const runProbe = useCallback(
		(apiKey: string) => {
			if (!isTauri()) return;
			if (!apiKey.trim()) {
				setStatus("idle");
				return;
			}
			probeAbortRef.current?.abort();
			const ac = new AbortController();
			probeAbortRef.current = ac;
			setStatus("probing");
			// Mask → Host resolves the stored token; plaintext draft → test pre-save.
			void probeLayoutProvider(provider.id, apiKey).then((ok) => {
				if (!ac.signal.aborted) setStatus(ok ? "ok" : "fail");
			});
		},
		[provider.id],
	);

	/**
	 * Persist the current card fields. Empty apiKey clears the stored secret,
	 * falls backends back to local when needed, and drops the provider from the
	 * selects — clearing the input triggers this immediately (no Confirm).
	 */
	const persistConfig = useCallback(
		async (apiKey: string) => {
			const baseUrl = provider.supportsBaseUrl ? displayBaseUrl.trim() : "";
			const model = provider.supportsModel ? displayModel.trim() : "";
			const prompt = provider.supportsPrompt ? displayPrompt.trim() : "";
			const language = provider.supportsLanguage ? displayLanguage : "";
			const isOcr = provider.supportsOcr ? displayIsOcr : false;
			const config = { apiKey, baseUrl, model, prompt, language, isOcr };

			if (!apiKey) {
				// Optimistic UI: hide from backend selects before Host round-trip.
				const cleared = layoutBackendsAfterClearingProvider(
					layout,
					provider.id,
				);
				patch({
					layout: {
						...layout,
						...cleared,
						providerConfigs: {
							...layout.providerConfigs,
							[provider.id]: { ...stored, ...config },
						},
					},
				});
				setDraft({});
				setStatus("idle");
			}

			const { displayLayout } = await persistLayoutProviderConfig({
				settings,
				provider: provider.id,
				config,
			});
			patch({ layout: displayLayout });
			setDraft({});
			if (!apiKey) {
				setStatus("idle");
				return;
			}
			runProbe(apiKey);
		},
		[
			displayBaseUrl,
			displayModel,
			displayPrompt,
			displayLanguage,
			displayIsOcr,
			layout,
			patch,
			provider,
			runProbe,
			settings,
			stored,
		],
	);

	const confirmProvider = useCallback(() => {
		void persistConfig(displayApiKey.trim());
	}, [displayApiKey, persistConfig]);

	useEffect(() => {
		return () => {
			probeAbortRef.current?.abort();
		};
	}, []);

	return (
		<ProviderCard
			label={providerName}
			open={open}
			onToggle={onToggle}
			header={
				<>
					<TooltipDot
						tone={probeTone(status, configured)}
						pulse={status === "probing"}
						label={t(
							probeStatusLabelKey(status) as "layout.providerConfig.probeIdle",
						)}
					/>
					<span className="truncate font-medium text-sm">{providerName}</span>
					<Button
						type="button"
						variant="link"
						size="xs"
						className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
						onClick={() =>
							openExternalUrl(LAYOUT_PROVIDER_DOCS_URLS[provider.id])
						}
					>
						<ExternalLink data-icon="inline-start" className="size-3" />
						{t("layout.providerConfig.openDocsLabel")}
					</Button>
				</>
			}
			actions={
				<Button
					type="button"
					variant="outline"
					size="xs"
					disabled={status === "probing"}
					onClick={() => void confirmProvider()}
				>
					{t("layout.providerConfig.confirm")}
				</Button>
			}
		>
			<div className="space-y-2">
				{provider.requiresApiKey ? (
					<ProviderField
						id={`layout-provider-${provider.id}-api-key`}
						label={t("layout.providerConfig.apiKey.label")}
					>
						<Input
							id={`layout-provider-${provider.id}-api-key`}
							type="password"
							value={displayApiKey}
							placeholder={t(
								`layout.providerConfig.apiKey.placeholder.${provider.id}` as "layout.providerConfig.apiKey.placeholder.paddle",
							)}
							className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
							spellCheck={false}
							autoComplete="off"
							onChange={(e) => {
								const next = e.target.value;
								if (!next.trim()) {
									setDraft((prev) => ({ ...prev, apiKey: "" }));
									// Clear immediately — do not wait for Confirm.
									if (
										stored.apiKey.trim() ||
										(isLayoutBackend(provider.id) &&
											layout.backend === provider.id) ||
										(isParserBackend(provider.id) &&
											layout.parserBackend === provider.id)
									) {
										void persistConfig("");
									} else {
										setStatus("idle");
									}
									return;
								}
								setDraft((prev) => ({ ...prev, apiKey: next }));
							}}
							onFocus={(e) => e.target.select()}
						/>
					</ProviderField>
				) : null}
				{provider.supportsBaseUrl ? (
					<ProviderField
						id={`layout-provider-${provider.id}-base-url`}
						label={t("layout.providerConfig.baseUrl.label")}
					>
						<Input
							id={`layout-provider-${provider.id}-base-url`}
							type="text"
							value={displayBaseUrl}
							placeholder={LAYOUT_PROVIDER_DEFAULT_BASE_URLS[provider.id]}
							className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, baseUrl: e.target.value }))
							}
						/>
					</ProviderField>
				) : null}
				{provider.supportsModel ? (
					<ProviderField
						id={`layout-provider-${provider.id}-model`}
						label={t("layout.providerConfig.model.label")}
					>
						<Input
							id={`layout-provider-${provider.id}-model`}
							type="text"
							value={displayModel}
							placeholder={modelPresets[0]}
							list={`layout-provider-${provider.id}-model-presets`}
							className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, model: e.target.value }))
							}
						/>
						<datalist id={`layout-provider-${provider.id}-model-presets`}>
							{modelPresets.map((preset) => (
								<option key={preset} value={preset} />
							))}
						</datalist>
					</ProviderField>
				) : null}
				{provider.supportsPrompt ? (
					<ProviderField
						id={`layout-provider-${provider.id}-prompt`}
						label={t("layout.providerConfig.prompt.label")}
					>
						<Input
							id={`layout-provider-${provider.id}-prompt`}
							type="text"
							value={displayPrompt}
							placeholder={t("layout.providerConfig.prompt.placeholder")}
							className="h-8 min-w-0 flex-1 font-mono text-xs placeholder:text-muted-foreground/50"
							spellCheck={false}
							autoComplete="off"
							onChange={(e) =>
								setDraft((prev) => ({ ...prev, prompt: e.target.value }))
							}
						/>
					</ProviderField>
				) : null}
				{provider.supportsLanguage || provider.supportsOcr ? (
					<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="flex items-center gap-1 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground"
								aria-label={t("layout.providerConfig.advanced")}
							>
								<ChevronRight
									className={cn(
										"size-3.5 transition-transform",
										advancedOpen && "rotate-90",
									)}
								/>
								{t("layout.providerConfig.advanced")}
							</button>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-2 pt-2">
							{provider.supportsLanguage ? (
								<ProviderField
									id={`layout-provider-${provider.id}-language`}
									label={
										<HelpLabel
											label={t("layout.providerConfig.language.label")}
											help={t("layout.providerConfig.language.help")}
										/>
									}
								>
									<Select
										value={displayLanguage}
										onValueChange={(value) =>
											setDraft((prev) => ({ ...prev, language: value }))
										}
									>
										<SelectTrigger
											id={`layout-provider-${provider.id}-language`}
											size="sm"
											className="h-8 min-w-32 max-w-44 text-xs"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent className="max-h-72">
											{MINERU_LANGUAGES.map((language) => (
												<SelectItem key={language} value={language}>
													{t(
														`layout.providerConfig.language.options.${language}` as "layout.providerConfig.language.options.en",
													)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</ProviderField>
							) : null}
							{provider.supportsOcr ? (
								<ProviderField
									id={`layout-provider-${provider.id}-force-ocr`}
									label={
										<HelpLabel
											label={t("layout.providerConfig.forceOcr.label")}
											help={t("layout.providerConfig.forceOcr.help")}
										/>
									}
								>
									<Switch
										id={`layout-provider-${provider.id}-force-ocr`}
										size="sm"
										checked={displayIsOcr}
										onCheckedChange={(checked) =>
											setDraft((prev) => ({
												...prev,
												isOcr: checked === true,
											}))
										}
									/>
								</ProviderField>
							) : null}
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</div>
		</ProviderCard>
	);
}
