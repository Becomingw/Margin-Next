import { Check, ChevronRight, LoaderCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { memo, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FontFamilyPicker } from "@/components/settings/font-family-picker";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/core/utils";
import type {
	AppSettings,
	LocalePreference,
	ThemePreference,
} from "@/lib/settings";
import {
	EDITOR_LINE_HEIGHT_MAX,
	EDITOR_LINE_HEIGHT_MIN,
	EDITOR_LINE_HEIGHT_STEP,
} from "@/lib/settings";
import {
	applyUiTheme,
	DEFAULT_UI_THEME,
	loadUiThemes,
	UI_THEMES,
	type UiThemeDef,
} from "@/lib/ui/theme";

export type AppearancePaneProps = {
	theme: ThemePreference;
	uiTheme: string;
	locale: LocalePreference;
	uiScale: number;
	editorFontSize: number;
	interfaceFontFamily: string;
	textFontFamily: string;
	monoFontFamily: string;
	editorLineHeight: number;
	showEditorToolbar: boolean;
	patch: (p: Partial<AppSettings>) => void;
};

/** Themes shown before "all themes" is expanded (plus the built-in default). */
const FEATURED_THEMES = new Set([
	DEFAULT_UI_THEME,
	"modern-minimal",
	"graphite",
	"catppuccin",
	"vintage-paper",
	"mono",
]);

function AppearancePaneInner({
	theme,
	uiTheme,
	locale,
	uiScale,
	editorFontSize,
	interfaceFontFamily,
	textFontFamily,
	monoFontFamily,
	editorLineHeight,
	showEditorToolbar,
	patch,
}: AppearancePaneProps) {
	const { t } = useTranslation("settings");
	const { resolvedTheme, setTheme } = useTheme();
	const interfaceFontId = useId();
	const textFontId = useId();
	const monoFontId = useId();
	const [themeDefs, setThemeDefs] = useState<UiThemeDef[]>([]);
	const [showAllThemes, setShowAllThemes] = useState(false);

	useEffect(() => {
		let active = true;
		void loadUiThemes()
			.then((themes) => {
				if (active) setThemeDefs(themes);
			})
			.catch(() => {
				// Manifest names remain usable if preview data fails to load.
			});
		return () => {
			active = false;
		};
	}, []);

	const setThemePref = (next: ThemePreference) => {
		patch({ theme: next });
		setTheme(next);
	};

	const isDark = resolvedTheme === "dark";
	// Mirror the built-in palette in index.css, independent of the active preset.
	const defaultPreview = {
		background: isDark ? "oklch(0.185 0.008 65)" : "oklch(0.985 0.004 80)",
		card: isDark ? "oklch(0.226 0.009 65)" : "oklch(0.998 0.002 80)",
		primary: isDark ? "oklch(0.91 0.012 80)" : "oklch(0.285 0.018 65)",
		secondary: isDark ? "oklch(0.27 0.009 70)" : "oklch(0.95 0.007 80)",
		accent: isDark ? "oklch(0.295 0.013 65)" : "oklch(0.938 0.012 75)",
		foreground: isDark ? "oklch(0.94 0.007 80)" : "oklch(0.245 0.012 65)",
		border: isDark ? "oklch(0.94 0.007 80 / 13%)" : "oklch(0.885 0.01 75)",
	};
	const allThemes = [
		{
			name: DEFAULT_UI_THEME,
			title: t("appearance.uiTheme.default"),
			light: defaultPreview,
			dark: defaultPreview,
		},
		...UI_THEMES.map(
			(meta) =>
				themeDefs.find((theme) => theme.name === meta.name) ?? {
					...meta,
					light: defaultPreview,
					dark: defaultPreview,
				},
		),
	];
	// A short curated row by default; the selected theme always stays visible.
	const previewThemes = showAllThemes
		? allThemes
		: allThemes.filter(
				(item) => FEATURED_THEMES.has(item.name) || item.name === uiTheme,
			);

	return (
		<>
			<PageTitle title={t("appearance.title")} />
			<SettingsGroup>
				<SettingsRow label={t("appearance.themeLabel")}>
					<Select
						value={theme}
						onValueChange={(v) => setThemePref(v as ThemePreference)}
					>
						<SelectTrigger size="sm" className="min-w-[120px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">
								{t("appearance.theme.system")}
							</SelectItem>
							<SelectItem value="light">
								{t("appearance.theme.light")}
							</SelectItem>
							<SelectItem value="dark">{t("appearance.theme.dark")}</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<div className="border-b border-hairline-soft px-3.5 py-3.5">
					<div className="mb-2.5 flex items-center justify-between gap-3">
						<span className="font-normal text-sm text-foreground">
							{t("appearance.uiThemeLabel")}
						</span>
						<span className="truncate text-muted-foreground text-xs">
							{allThemes.find((item) => item.name === uiTheme)?.title ??
								uiTheme}
						</span>
					</div>
					<div className="grid grid-cols-1 auto-rows-[7.25rem] gap-2 @sm/settings-content:grid-cols-2 @xl/settings-content:grid-cols-3">
						{previewThemes.map((item) => {
							const colors = isDark ? item.dark : item.light;
							const selected = item.name === uiTheme;
							return (
								<button
									key={item.name}
									type="button"
									aria-label={t("appearance.uiTheme.select", {
										name: item.title,
									})}
									aria-pressed={selected}
									onClick={() => {
										patch({ uiTheme: item.name });
										void applyUiTheme(item.name);
									}}
									className={cn(
										"group h-[7.25rem] min-w-0 rounded-lg border p-1 text-left outline-none",
										"transition-[border-color,box-shadow,transform,background-color] duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)]",
										"hover:border-primary/55 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
										"active:scale-[0.98]",
										selected
											? "border-primary/80 bg-primary/5 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_35%,transparent)]"
											: "border-border",
									)}
								>
									<div
										className="overflow-hidden rounded-md border border-black/10 p-1.5 dark:border-white/10"
										style={{ backgroundColor: colors.background }}
									>
										<div className="mb-1 flex items-center gap-1">
											<span
												className="h-1.5 w-1/3 rounded-full"
												style={{ backgroundColor: colors.primary }}
											/>
											<span
												className="h-1.5 flex-1 rounded-full opacity-60"
												style={{ backgroundColor: colors.foreground }}
											/>
										</div>
										<div
											className="rounded-sm border p-1.5"
											style={{
												backgroundColor: colors.card,
												borderColor: colors.border,
											}}
										>
											<div
												className="mb-1 h-1 w-2/3 rounded-full bg-current opacity-50"
												style={{ color: colors.foreground }}
											/>
											<div className="flex gap-1">
												<span
													className="h-2.5 flex-1 rounded-sm"
													style={{ backgroundColor: colors.secondary }}
												/>
												<span
													className="h-2.5 w-1/3 rounded-sm"
													style={{ backgroundColor: colors.accent }}
												/>
											</div>
										</div>
									</div>
									<div className="flex min-w-0 items-center gap-1.5 px-1 py-1">
										<span className="truncate font-medium text-xs">
											{item.title}
										</span>
										{selected ? (
											<Check
												className="ml-auto size-3.5 shrink-0 text-primary"
												aria-hidden
											/>
										) : null}
									</div>
								</button>
							);
						})}
					</div>
					{themeDefs.length === 0 ? (
						<LoaderCircle className="mx-auto mt-2 size-3.5 animate-spin text-muted-foreground" />
					) : null}
					<button
						type="button"
						className="mt-2 flex items-center gap-1 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
						aria-expanded={showAllThemes}
						onClick={() => setShowAllThemes((open) => !open)}
					>
						<ChevronRight
							className={cn(
								"size-3.5 transition-transform",
								showAllThemes && "rotate-90",
							)}
							aria-hidden
						/>
						{showAllThemes
							? t("appearance.uiTheme.fewer")
							: t("appearance.uiTheme.more", { count: allThemes.length })}
					</button>
				</div>
				<SettingsRow label={t("appearance.languageLabel")}>
					<Select
						value={locale}
						onValueChange={(v) => patch({ locale: v as LocalePreference })}
					>
						<SelectTrigger size="sm" className="min-w-[120px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="system">
								{t("appearance.language.system")}
							</SelectItem>
							<SelectItem value="en">{t("appearance.language.en")}</SelectItem>
							<SelectItem value="zh-CN">
								{t("appearance.language.zhCN")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SliderRow
					label={t("appearance.uiScale.label")}
					value={Math.round(uiScale * 100)}
					min={80}
					max={150}
					step={1}
					format={(percent) => t("appearance.uiScale.value", { percent })}
					onCommit={(percent) => patch({ uiScale: percent / 100 })}
				/>
			</SettingsGroup>

			<SettingsSectionLabel>
				{t("appearance.fonts.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow
					label={t("appearance.fonts.interface")}
					htmlFor={interfaceFontId}
				>
					<FontFamilyPicker
						id={interfaceFontId}
						fontRole="interface"
						value={interfaceFontFamily}
						onChange={(v) => patch({ interfaceFontFamily: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("appearance.fonts.text")} htmlFor={textFontId}>
					<FontFamilyPicker
						id={textFontId}
						fontRole="text"
						value={textFontFamily}
						onChange={(v) => patch({ textFontFamily: v })}
					/>
				</SettingsRow>
				<SettingsRow label={t("appearance.fonts.mono")} htmlFor={monoFontId}>
					<FontFamilyPicker
						id={monoFontId}
						fontRole="mono"
						value={monoFontFamily}
						onChange={(v) => patch({ monoFontFamily: v })}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsSectionLabel>
				{t("appearance.markdownEditor.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SliderRow
					label={t("appearance.fontSize.label")}
					value={editorFontSize}
					min={12}
					max={20}
					step={1}
					format={(size) => t("appearance.fontSize.value", { size })}
					onCommit={(size) => patch({ editorFontSize: size })}
				/>
				<SliderRow
					label={t("appearance.lineHeight.label")}
					value={editorLineHeight}
					min={EDITOR_LINE_HEIGHT_MIN}
					max={EDITOR_LINE_HEIGHT_MAX}
					step={EDITOR_LINE_HEIGHT_STEP}
					format={(value) =>
						t("appearance.lineHeight.value", { value: value.toFixed(1) })
					}
					onCommit={(value) => patch({ editorLineHeight: value })}
				/>
				<SettingsRow
					label={t("appearance.editorToolbar.label")}
					htmlFor="editor-toolbar"
				>
					<Switch
						id="editor-toolbar"
						checked={showEditorToolbar}
						onCheckedChange={(v) => patch({ showEditorToolbar: v })}
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

/**
 * Range input that previews locally while dragging and commits the value
 * after a short pause, so each tick does not round-trip through settings.
 */
function SliderRow({
	label,
	value,
	min,
	max,
	step,
	format,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	format: (value: number) => string;
	onCommit: (value: number) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(value);
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;

	useEffect(() => {
		setDraft(value);
	}, [value]);

	useEffect(() => {
		if (draft === value) return;
		const timer = setTimeout(() => commitRef.current(draft), 150);
		return () => clearTimeout(timer);
	}, [draft, value]);

	const text = format(draft);
	return (
		<SettingsRow label={label} htmlFor={id}>
			<div className="flex items-center gap-2">
				<input
					id={id}
					type="range"
					min={min}
					max={max}
					step={step}
					value={draft}
					onChange={(e) => setDraft(Number(e.target.value))}
					aria-valuemin={min}
					aria-valuemax={max}
					aria-valuenow={draft}
					aria-valuetext={text}
					className="w-28 accent-primary"
				/>
				<span className="w-12 text-right text-muted-foreground text-xs tabular-nums">
					{text}
				</span>
			</div>
		</SettingsRow>
	);
}

export const AppearancePane = memo(AppearancePaneInner);
