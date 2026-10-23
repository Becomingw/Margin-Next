import { appLogDir } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { clearUsage } from "@/lib/activity";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import { clearLogs } from "@/lib/core/logger";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { remoteCacheClear } from "@/lib/vault/remote/remote-vault";

/** Browse's own profile: every site's cookies and storage. */
function ClearBrowsingRow() {
	const { t } = useTranslation("settings");
	const [isolated, setIsolated] = useState<boolean | null>(null);
	useEffect(() => {
		void commands.browseProfileIsolated().then(setIsolated);
	}, []);
	return (
		<SettingsRow
			label={t("general.privacy.clearBrowsing.label")}
			description={
				isolated === false
					? t("general.privacy.clearBrowsing.unavailable")
					: t("general.privacy.clearBrowsing.hint")
			}
		>
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={!isolated}
				onClick={() => {
					void callApiResult(() => commands.browseClearAll())
						.then(() => notifySuccess(t("general.privacy.clearBrowsing.done")))
						.catch((e) => notifyError(errorText(e)));
				}}
			>
				{t("general.privacy.clearBrowsing.action")}
			</Button>
		</SettingsRow>
	);
}

/** Local data the app keeps outside the vault: usage history, remote cache, logs. */
export function DataSettingsBlock() {
	const { t } = useTranslation("settings");
	const [busy, setBusy] = useState<"cache" | "logs" | null>(null);

	const run = async (
		kind: "cache" | "logs",
		action: () => Promise<unknown>,
		done: string,
	) => {
		setBusy(kind);
		try {
			await action();
			notifySuccess(done);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<SettingsSectionLabel>{t("general.sections.data")}</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.privacy.clearUsage.label")}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							void clearUsage()
								.then(() => notifySuccess(t("general.privacy.clearUsage.done")))
								.catch((e) => notifyError(errorText(e)));
						}}
					>
						{t("general.privacy.clearUsage.action")}
					</Button>
				</SettingsRow>
				{isTauri() ? <ClearBrowsingRow /> : null}
				{isTauri() ? (
					<>
						<SettingsRow label={t("remoteAccess.cache.label")}>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={busy !== null}
								onClick={() =>
									void run(
										"cache",
										remoteCacheClear,
										t("remoteAccess.cache.cleared"),
									)
								}
							>
								{busy === "cache" ? (
									<LoaderCircle
										data-icon="inline-start"
										className="animate-spin"
									/>
								) : null}
								{t("remoteAccess.cache.clear")}
							</Button>
						</SettingsRow>
						<SettingsRow label={t("about.logs.label")}>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										void appLogDir()
											.then(openPath)
											.catch((error) =>
												notifyError(t("about.logs.openFailed"), {
													description: String(error),
												}),
											);
									}}
								>
									{t("about.logs.open")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() =>
										void run("logs", clearLogs, t("about.logs.clearDone"))
									}
								>
									{busy === "logs" ? (
										<LoaderCircle
											data-icon="inline-start"
											className="animate-spin"
										/>
									) : null}
									{t("about.logs.clear")}
								</Button>
							</div>
						</SettingsRow>
					</>
				) : null}
			</SettingsGroup>
		</>
	);
}
