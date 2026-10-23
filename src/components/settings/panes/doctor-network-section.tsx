import { useTranslation } from "react-i18next";
import { Dot, type StatusDotTone } from "@/components/settings/status-dot";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/core/utils";
import type {
	NetworkDoctorReport,
	NetworkEndpointDiagnostic,
	NetworkStatus,
} from "@/lib/doctor/api";
import { DoctorRunButton, DoctorSection } from "./doctor-sections";

const NETWORK_TONE: Record<NetworkStatus, StatusDotTone> = {
	reachable: "ok",
	timeout: "warn",
	unreachable: "err",
};

function EndpointRowShimmer() {
	return (
		<div
			className="flex items-center justify-between gap-3 border-b px-3.5 py-2.5 last:border-b-0"
			aria-hidden
		>
			<div className="flex items-center gap-2.5">
				<Skeleton className="library-shimmer size-2 shrink-0 rounded-full" />
				<Skeleton className="library-shimmer h-3.5 w-24" />
			</div>
			<Skeleton className="library-shimmer h-3 w-14" />
		</div>
	);
}

function EndpointRow({ endpoint }: { endpoint: NetworkEndpointDiagnostic }) {
	const { t } = useTranslation("settings");
	const reachable = endpoint.status === "reachable";
	const hintKey =
		endpoint.status === "timeout"
			? "doctor.network.hints.timeout"
			: endpoint.status === "unreachable"
				? "doctor.network.hints.unreachable"
				: null;
	return (
		<div className="flex items-start gap-2.5 border-b px-3.5 py-2.5 last:border-b-0">
			<Dot tone={NETWORK_TONE[endpoint.status]} className="mt-1" />
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline justify-between gap-3">
					<p className="font-medium text-sm">
						{t(`doctor.network.endpoints.${endpoint.id}`)}
					</p>
					<p
						className={cn(
							"shrink-0 text-xs",
							reachable ? "text-emerald-700" : "text-amber-700",
						)}
					>
						{reachable
							? t("doctor.network.latency", { ms: endpoint.latencyMs })
							: t(`doctor.network.status.${endpoint.status}`)}
					</p>
				</div>
				{!reachable && hintKey ? (
					<div className="mt-1 space-y-0.5">
						{endpoint.detail ? (
							<p className="whitespace-pre-wrap break-words text-muted-foreground text-xs">
								{endpoint.detail}
							</p>
						) : null}
						<p className="text-muted-foreground text-xs">{t(hintKey)}</p>
					</div>
				) : null}
			</div>
		</div>
	);
}

/** Probes every endpoint, so it only runs when asked (`onRun`, or the host's own button). */
export function DoctorNetworkSection({
	report,
	loading,
	onRun,
}: {
	report: NetworkDoctorReport | null;
	loading: boolean;
	onRun?: () => void;
}) {
	const { t } = useTranslation("settings");
	const endpoints = report?.endpoints ?? [];
	const proxy = report?.proxy;
	const issues = endpoints.filter(
		(endpoint) => endpoint.status !== "reachable",
	).length;
	const showShimmer = loading && endpoints.length === 0;
	return (
		<DoctorSection
			title={t("doctor.sections.network")}
			description={t("doctor.sectionHints.network")}
			ok={issues === 0}
			issueCount={issues}
			pending={!report}
			action={
				onRun ? <DoctorRunButton running={loading} onRun={onRun} /> : null
			}
		>
			{showShimmer ? (
				<div
					role="status"
					aria-busy="true"
					aria-label={t("doctor.network.probing")}
				>
					<EndpointRowShimmer />
					<EndpointRowShimmer />
					<EndpointRowShimmer />
				</div>
			) : endpoints.length > 0 ? (
				<>
					{endpoints.map((endpoint) => (
						<EndpointRow key={endpoint.id} endpoint={endpoint} />
					))}
					{proxy ? (
						<div className="px-3.5 py-2.5">
							<p className="text-muted-foreground text-xs">
								{t("doctor.network.proxy", { proxy })}
							</p>
						</div>
					) : null}
				</>
			) : report ? (
				<div className="px-3.5 py-2.5">
					<p className="text-muted-foreground text-xs">
						{t("doctor.network.none")}
					</p>
				</div>
			) : null}
		</DoctorSection>
	);
}
