import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageTitle } from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	type DoctorReport,
	doctorCheck,
	doctorCheckNetwork,
	type NetworkDoctorReport,
} from "@/lib/doctor/api";
import { DoctorAliasSection } from "./doctor-alias-section";
import { DoctorNetworkSection } from "./doctor-network-section";
import { DoctorPassedSummary } from "./doctor-sections";
import {
	DoctorCatalogSection,
	DoctorVaultSection,
} from "./doctor-vault-catalog-sections";
import { DoctorVisualMarksSection } from "./doctor-visual-marks-section";
import { DoctorWikilinkSection } from "./doctor-wikilink-section";

export function DoctorPane({
	vaultPath,
	hostContext,
}: {
	vaultPath?: string | null;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation("settings");
	const [report, setReport] = useState<DoctorReport | null>(null);
	const [networkReport, setNetworkReport] =
		useState<NetworkDoctorReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [networkLoading, setNetworkLoading] = useState(false);
	const [wikiPlanning, setWikiPlanning] = useState(false);

	const refresh = useCallback(async () => {
		if (hostContext.kind === "remote") return;
		setLoading(true);
		try {
			if (vaultPath) {
				try {
					setReport(await doctorCheck(vaultPath));
				} catch (error) {
					notifyError(errorText(error));
				}
			}
		} finally {
			setLoading(false);
		}
	}, [hostContext.kind, vaultPath]);

	// Network probes can take up to the timeout per host, so they run only on
	// request, not on opening the pane.
	const refreshNetwork = useCallback(async () => {
		if (hostContext.kind === "remote") return;
		setNetworkLoading(true);
		try {
			setNetworkReport(await doctorCheckNetwork());
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setNetworkLoading(false);
		}
	}, [hostContext.kind]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (hostContext.kind === "remote") {
		return (
			<>
				<PageTitle title={t("doctor.title")} />
				<p className="rounded-xl border bg-muted/30 px-4 py-3 text-muted-foreground text-sm">
					{t("doctor.remoteUnavailable")}
				</p>
			</>
		);
	}
	const catalogIssues = report?.catalog.issues ?? [];
	const hasCatalogDuplicates =
		(report?.catalog.duplicateReport?.duplicateIds.length ?? 0) > 0 ||
		(report?.catalog.duplicateReport?.duplicatePaths.length ?? 0) > 0;
	// Clean checks collapse into one summary line; only problems get a section.
	const vaultClean = Boolean(
		report?.vault.ok && report.vault.issues.length === 0,
	);
	const catalogClean = Boolean(
		report?.catalog.ok && catalogIssues.length === 0 && !hasCatalogDuplicates,
	);
	const wikilinksClean = (report?.wikilinks.issues.length ?? 0) === 0;
	const aliasesClean = Boolean(
		report?.aliases.ok &&
			report.aliases.issues.length === 0 &&
			(report.aliases.ignoredPaths?.length ?? 0) === 0,
	);
	const visualMarksClean =
		!report?.visualMarks ||
		(report.visualMarks.ok && report.visualMarks.issues.length === 0);
	const passed = [
		vaultClean && t("doctor.sections.vault"),
		catalogClean && t("doctor.sections.catalog"),
		wikilinksClean && t("doctor.sections.wikilinks"),
		aliasesClean && t("doctor.sections.aliases"),
	].filter((title): title is string => Boolean(title));

	return (
		<>
			<PageTitle
				title={t("doctor.title")}
				actions={
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={t("doctor.refresh")}
								disabled={loading || wikiPlanning || networkLoading}
								onClick={() => {
									void refresh();
									if (networkReport) void refreshNetwork();
								}}
							>
								<RefreshCw className={loading ? "animate-spin" : undefined} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("doctor.refresh")}</TooltipContent>
					</Tooltip>
				}
			/>

			<DoctorNetworkSection
				report={networkReport}
				loading={networkLoading}
				onRun={() => void refreshNetwork()}
			/>

			{vaultPath ? (
				!report ? null : (
					<>
						{passed.length > 0 ? <DoctorPassedSummary titles={passed} /> : null}

						{vaultClean ? null : (
							<DoctorVaultSection
								ok={report.vault.ok}
								issues={report.vault.issues}
							/>
						)}

						{catalogClean ? null : (
							<DoctorCatalogSection
								vaultPath={vaultPath}
								ok={report.catalog.ok}
								issues={catalogIssues}
								hasDuplicates={hasCatalogDuplicates}
								onRefresh={refresh}
							/>
						)}

						{wikilinksClean ? null : (
							<DoctorWikilinkSection
								key={vaultPath}
								vaultPath={vaultPath}
								wikilinks={report.wikilinks}
								planning={wikiPlanning}
								onPlanningChange={setWikiPlanning}
								onRefresh={refresh}
							/>
						)}

						{aliasesClean ? null : (
							<DoctorAliasSection
								vaultPath={vaultPath}
								aliases={report.aliases}
								onRefresh={refresh}
							/>
						)}

						{/* One-off legacy upgrade: only shown while old marks remain. */}
						{visualMarksClean ? null : (
							<DoctorVisualMarksSection
								vaultPath={vaultPath}
								visualMarks={report.visualMarks}
								onRefresh={refresh}
							/>
						)}
					</>
				)
			) : (
				<p className="rounded-xl border bg-muted/30 px-4 py-3 text-muted-foreground text-sm">
					{t("doctor.openVault")}
				</p>
			)}
		</>
	);
}
