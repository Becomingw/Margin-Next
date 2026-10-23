import { getVersion } from "@tauri-apps/api/app";
import {
	Download,
	LoaderCircle,
	MousePointerClick,
	RefreshCw,
	Star,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import eddaAppIcon from "@/assets/edda-app-icon.svg";
import {
	PageTitle,
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import {
	type FinderServiceStatus,
	fetchFinderServiceStatus,
	installFinderService,
	uninstallFinderService,
} from "@/lib/shell/native-integration";
import {
	checkForUpdate,
	getUpdateSnapshot,
	installAvailableUpdate,
	subscribeUpdate,
	type UpdateSnapshot,
} from "@/lib/update";

const GITHUB_REPOSITORY = "Becomingw/Edda";

export function AboutPane() {
	const { t } = useTranslation("settings");
	const [version, setVersion] = useState<string>();
	const [update, setUpdate] = useState<UpdateSnapshot>(getUpdateSnapshot);
	const [finder, setFinder] = useState<FinderServiceStatus | null>(null);
	const [finderBusy, setFinderBusy] = useState(false);
	useEffect(() => {
		void getVersion()
			.then(setVersion)
			.catch(() => undefined);
	}, []);
	useEffect(() => subscribeUpdate(setUpdate), []);
	useEffect(() => {
		if (isTauri() && isMacOS())
			void fetchFinderServiceStatus()
				.then(setFinder)
				.catch(() => setFinder(null));
	}, []);
	const install = () => {
		void installAvailableUpdate().then((next) => {
			if (next.phase === "error") notifyError(t("about.update.installFailed"));
		});
	};
	const changeFinder = async (remove: boolean) => {
		setFinderBusy(true);
		try {
			setFinder(
				await (remove ? uninstallFinderService() : installFinderService()),
			);
			notifySuccess(
				t(
					remove
						? "about.finder.uninstallSuccess"
						: "about.finder.installSuccess",
				),
			);
		} catch (error) {
			notifyError(
				t(
					remove
						? "about.finder.uninstallFailed"
						: "about.finder.installFailed",
				),
				{ description: String(error) },
			);
		} finally {
			setFinderBusy(false);
		}
	};
	const checking = update.phase === "checking";
	const installing =
		update.phase === "downloading" || update.phase === "installing";
	const needsFinderUpdate = Boolean(finder?.installed && !finder.current);
	return (
		<>
			<PageTitle
				title={t("about.title")}
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							openExternalUrl(`https://github.com/${GITHUB_REPOSITORY}`)
						}
					>
						<Star data-icon="inline-start" className="star-twinkle" />
						{t("about.starGithub", { repository: GITHUB_REPOSITORY })}
					</Button>
				}
			/>
			<SettingsGroup>
				<div className="flex items-center justify-between gap-4 px-3.5 py-4">
					<div className="flex min-w-0 items-center gap-3">
						<img
							src={eddaAppIcon}
							alt=""
							aria-hidden
							className="size-10 shrink-0 rounded-lg"
						/>
						<div className="min-w-0 space-y-0.5">
							<p className="font-semibold text-base text-foreground">Edda</p>
							{version && (
								<p className="text-muted-foreground text-xs">
									{t("about.version", { version })}
								</p>
							)}
						</div>
					</div>
					<div className="flex shrink-0 items-center">
						{update.phase === "available" ? (
							<Button size="sm" onClick={install}>
								<Download data-icon="inline-start" />
								{t("about.update.downloadInstall")}
							</Button>
						) : update.phase === "unsupported" ? null : (
							<Button
								variant="outline"
								size="sm"
								disabled={checking || installing}
								onClick={() => void checkForUpdate()}
							>
								{checking || installing ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : (
									<RefreshCw data-icon="inline-start" />
								)}
								{t("about.update.check")}
							</Button>
						)}
					</div>
				</div>
				{update.phase === "available" && update.notes?.trim() ? (
					<div className="border-t px-3.5 py-2.5 text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
						{update.notes.trim()}
					</div>
				) : null}
			</SettingsGroup>
			{isMacOS() && isTauri() && finder?.supported !== false ? (
				<SettingsGroup>
					<SettingsRow
						label={
							<span className="inline-flex items-center gap-1.5">
								<MousePointerClick
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{t("about.finder.label")}
							</span>
						}
						description={
							!finder
								? "…"
								: t(
										finder.installed
											? finder.current
												? "about.finder.descriptionInstalled"
												: "about.finder.stale"
											: "about.finder.description",
									)
						}
					>
						<div className="flex flex-wrap items-center justify-end gap-2">
							{finder?.installed && (
								<Button
									variant="outline"
									size="sm"
									disabled={finderBusy}
									onClick={() => void changeFinder(true)}
								>
									{finderBusy && (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									)}
									{t("about.finder.uninstall")}
								</Button>
							)}
							{(!finder?.installed || needsFinderUpdate) && (
								<Button
									size="sm"
									disabled={finderBusy || !finder}
									onClick={() => void changeFinder(false)}
								>
									{finderBusy ? (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									) : (
										<Download data-icon="inline-start" />
									)}
									{t(
										needsFinderUpdate
											? "about.finder.update"
											: "about.finder.install",
									)}
								</Button>
							)}
						</div>
					</SettingsRow>
				</SettingsGroup>
			) : null}
		</>
	);
}
