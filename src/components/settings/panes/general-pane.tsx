import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataSettingsBlock } from "@/components/settings/panes/data-settings-block";
import { DeveloperModeBlock } from "@/components/settings/panes/developer-mode-block";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import { probeTone, StatusDot } from "@/components/settings/status-dot";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import {
	type EasyScholarProbeStatus,
	hasEasyScholarKey,
	isEasyScholarKeyMask,
	maskEasyScholarKey,
	probeEasyScholarKey,
} from "@/lib/easyscholar";
import {
	PAPER_TREE_LABEL_MODES,
	PAPER_TREE_SORT_MODES,
	type PaperTreeLabelMode,
	type PaperTreeSortMode,
} from "@/lib/paper";
import {
	type AppSettings,
	AUTO_UPDATE_INTERNAL_LINKS,
	type AutoUpdateInternalLinks,
	PAPER_NOTE_MODES,
	type PaperNoteMode,
	saveSettingsAsync,
} from "@/lib/settings";
import { notesTemplateSeed } from "@/lib/vault/note-template";

export function GeneralPane({
	settings,
	patch,
	hostContext,
	vaultPath = null,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: SettingsHostContext;
	vaultPath?: string | null;
}) {
	const { t } = useTranslation("settings");
	const [easyScholarKeyDraft, setEasyScholarKeyDraft] = useState(
		settings.easyScholarKey,
	);
	const [seedingTemplate, setSeedingTemplate] = useState(false);

	// Custom note mode seeds `.edda/templates/NOTES.md` in the active vault;
	// remote vaults have no local template file to create.
	const canSeedTemplate = Boolean(vaultPath) && hostContext.kind === "local";

	const seedTemplate = async () => {
		if (!vaultPath || !canSeedTemplate) return;
		setSeedingTemplate(true);
		try {
			const res = await notesTemplateSeed(vaultPath);
			notifySuccess(
				t(
					res.created
						? "general.paperNoteMode.seedCreated"
						: "general.paperNoteMode.seedExists",
				),
			);
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setSeedingTemplate(false);
		}
	};

	useEffect(() => {
		setEasyScholarKeyDraft(settings.easyScholarKey);
	}, [settings.easyScholarKey]);

	return (
		<>
			<PageTitle title={t("general.title")} />
			{hostContext.kind === "remote" ? (
				<p className="mb-3 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-muted-foreground text-xs leading-relaxed">
					{t("host.remoteContextHint", {
						host: hostContext.label,
						path: hostContext.remotePath || "—",
					})}
				</p>
			) : null}
			<SettingsGroup>
				<SettingsRow label={t("general.paperTreeLabelMode.label")}>
					<Select
						value={settings.paperTreeLabelMode}
						onValueChange={(v) =>
							patch({ paperTreeLabelMode: v as PaperTreeLabelMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_TREE_LABEL_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperTreeLabelMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.paperTreeSortMode.label")}>
					<Select
						value={settings.paperTreeSortMode}
						onValueChange={(v) =>
							patch({ paperTreeSortMode: v as PaperTreeSortMode })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_TREE_SORT_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperTreeSortMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("general.plaza.label")} htmlFor="plaza-enabled">
					<Switch
						id="plaza-enabled"
						checked={settings.plazaEnabled}
						onCheckedChange={(v) => patch({ plazaEnabled: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsSectionLabel>{t("general.sections.notes")}</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.paperNoteMode.label")}>
					<Select
						value={settings.paperNoteMode}
						onValueChange={(v) => patch({ paperNoteMode: v as PaperNoteMode })}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAPER_NOTE_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.paperNoteMode.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				{settings.paperNoteMode === "custom" ? (
					<SettingsRow
						label={
							<code className="font-mono text-muted-foreground text-xs">
								.edda/templates/NOTES.md
							</code>
						}
					>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={seedingTemplate || !canSeedTemplate}
							onClick={() => void seedTemplate()}
						>
							{t("general.paperNoteMode.seed")}
						</Button>
					</SettingsRow>
				) : null}
				<SettingsRow
					label={t("general.autoOpenPaperNotes.label")}
					htmlFor="auto-open-paper-notes"
				>
					<Switch
						id="auto-open-paper-notes"
						checked={settings.autoOpenPaperNotes}
						onCheckedChange={(v) => patch({ autoOpenPaperNotes: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("general.autoUpdateInternalLinks.label")}>
					<Select
						value={settings.autoUpdateInternalLinks}
						onValueChange={(value) =>
							patch({
								autoUpdateInternalLinks: value as AutoUpdateInternalLinks,
							})
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{AUTO_UPDATE_INTERNAL_LINKS.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{t(`general.autoUpdateInternalLinks.${mode}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow
					label={t("general.export.watermark.label")}
					htmlFor="export-watermark-enabled"
				>
					<Switch
						id="export-watermark-enabled"
						checked={settings.exportWatermarkEnabled}
						onCheckedChange={(v) => patch({ exportWatermarkEnabled: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
			<SettingsSectionLabel>
				{t("general.sections.import")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow
					label={t("general.replaceCurrentTabOnOpenPaper.label")}
					htmlFor="replace-current-tab-on-open-paper"
				>
					<Switch
						id="replace-current-tab-on-open-paper"
						checked={settings.replaceCurrentTabOnOpenPaper}
						onCheckedChange={(v) => patch({ replaceCurrentTabOnOpenPaper: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("general.batchImportConcurrency.label")}>
					<Select
						value={String(settings.batchImportConcurrency)}
						onValueChange={(value) =>
							patch({ batchImportConcurrency: Number(value) })
						}
					>
						<SelectTrigger size="sm" className="min-w-[180px] max-w-[240px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Array.from({ length: 10 }, (_, index) => index + 1).map(
								(value) => (
									<SelectItem key={value} value={String(value)}>
										{t("general.batchImportConcurrency.value", { value })}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</SettingsRow>
				<EasyScholarKeyRow
					savedKey={settings.easyScholarKey}
					keyDraft={easyScholarKeyDraft}
					onKeyDraftChange={setEasyScholarKeyDraft}
					onCommitKey={async (value) => {
						const trimmed = value.trim();
						const next = await saveSettingsAsync({
							...settings,
							easyScholarKey: trimmed,
						});
						setEasyScholarKeyDraft(next.easyScholarKey);
					}}
				/>
			</SettingsGroup>
			<DataSettingsBlock />
			<DeveloperModeBlock
				settings={settings}
				patch={patch}
				vaultPath={vaultPath}
			/>
		</>
	);
}

/** EasyScholar key with a live probe dot; empty disables it. */
function EasyScholarKeyRow({
	savedKey,
	keyDraft,
	onKeyDraftChange,
	onCommitKey,
}: {
	savedKey: string;
	keyDraft: string;
	onKeyDraftChange: (value: string) => void;
	onCommitKey: (value: string) => Promise<void>;
}) {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<EasyScholarProbeStatus>("idle");
	const abortRef = useRef<AbortController | null>(null);

	const runProbe = useCallback(async () => {
		if (!hasEasyScholarKey(savedKey)) {
			setStatus("idle");
			return;
		}
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setStatus("probing");
		const ok = await probeEasyScholarKey(ac.signal);
		if (ac.signal.aborted) return;
		setStatus(ok ? "ok" : "fail");
	}, [savedKey]);

	useEffect(() => {
		void runProbe();
		return () => {
			abortRef.current?.abort();
		};
	}, [runProbe]);

	const changed = useMemo(() => {
		const saved = savedKey.trim();
		const draft = keyDraft.trim();
		if (!saved && !draft) return false;
		if (!saved || !draft) return true;
		return draft !== saved;
	}, [savedKey, keyDraft]);

	const handleConfirm = async () => {
		await onCommitKey(keyDraft.trim());
	};

	const statusLabel = t(
		status === "idle"
			? "general.easyScholar.probeIdle"
			: status === "probing"
				? "general.easyScholar.probeProbing"
				: status === "ok"
					? "general.easyScholar.probeOk"
					: "general.easyScholar.probeFail",
	);

	return (
		<SettingsRow
			label={
				<span className="inline-flex items-center gap-1.5">
					{t("general.easyScholar.keyLabel")}
					<StatusDot tone={probeTone(status)} label={statusLabel} />
				</span>
			}
			htmlFor="easy-scholar-key"
		>
			<div className="flex items-center gap-2">
				<Input
					id="easy-scholar-key"
					type="password"
					autoComplete="off"
					placeholder={t("general.easyScholar.placeholder")}
					className="h-8 w-64 max-w-[18rem] font-mono text-xs"
					value={keyDraft}
					onChange={(e) => {
						const next = e.currentTarget.value;
						const shownMask = hasEasyScholarKey(savedKey)
							? isEasyScholarKeyMask(savedKey)
								? savedKey
								: maskEasyScholarKey(savedKey)
							: null;
						if (
							shownMask != null &&
							(next === shownMask || next.startsWith(shownMask))
						) {
							onKeyDraftChange(next.slice(shownMask.length));
						} else {
							onKeyDraftChange(next);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							void handleConfirm();
						}
					}}
				/>
				<Button
					type="button"
					variant="outline"
					size="xs"
					disabled={!changed || status === "probing"}
					onClick={() => void handleConfirm()}
				>
					{t("general.easyScholar.confirm")}
				</Button>
			</div>
		</SettingsRow>
	);
}
