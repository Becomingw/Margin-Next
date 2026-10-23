import {
	CheckCircle2,
	ExternalLink,
	LoaderCircle,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { doctorCheckHost, type HostDoctorReport } from "@/lib/doctor/api";

export type AgentRuntimeGuideHandle = { refresh: () => Promise<void> };

/** Advisory only: native Agent installations need not depend on Node or npm. */
export const AgentRuntimeGuide = forwardRef<
	AgentRuntimeGuideHandle,
	{ onRecheck?: () => void }
>(function AgentRuntimeGuide({ onRecheck }, ref) {
	const { t } = useTranslation("settings");
	const [report, setReport] = useState<HostDoctorReport | null>(null);
	const [checking, setChecking] = useState(false);
	const mounted = useRef(false);
	const inFlight = useRef<Promise<void> | null>(null);
	const refresh = useCallback((): Promise<void> => {
		if (!isTauri()) return Promise.resolve();
		if (inFlight.current) return inFlight.current;
		setChecking(true);
		const request = doctorCheckHost()
			.then((next) => {
				if (mounted.current) setReport(next);
			})
			.catch((error) => {
				if (!mounted.current) return;
				setReport(null);
				notifyError(t("agent.runtime.checkFailed"), {
					description: errorText(error),
				});
			})
			.finally(() => {
				inFlight.current = null;
				if (mounted.current) setChecking(false);
			});
		inFlight.current = request;
		return request;
	}, [t]);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		return () => {
			mounted.current = false;
		};
	}, [refresh]);
	useImperativeHandle(ref, () => ({ refresh }), [refresh]);

	const needsAttention = Boolean(
		report &&
			(report.node.status !== "available" || report.npm.status !== "available"),
	);
	const statusKey = checking
		? "checking"
		: !report
			? "unknown"
			: needsAttention
				? "missing"
				: "detected";
	const recheckButton = (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			disabled={checking || !isTauri()}
			title={t("agent.runtime.recheck")}
			aria-label={t("agent.runtime.recheck")}
			onClick={() => {
				void refresh().then(() => {
					if (mounted.current) onRecheck?.();
				});
			}}
		>
			<RefreshCw className="size-3.5" aria-hidden />
		</Button>
	);
	// Everything in place: one quiet status line, no guide.
	if (statusKey === "detected" && report) {
		return (
			<section
				data-agent-runtime-guide
				aria-label={t("agent.runtime.title")}
				className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-1.5 text-xs"
			>
				<div
					role="status"
					className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
				>
					<CheckCircle2
						className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
						aria-hidden
					/>
					<span className="shrink-0 text-foreground">
						{t("agent.runtime.title")}
					</span>
					<span className="truncate">
						{[
							`Node.js ${report.node.version ?? ""}`,
							`npm ${report.npm.version ?? ""}`,
						]
							.map((part) => part.trim())
							.join(" · ")}
					</span>
				</div>
				{recheckButton}
			</section>
		);
	}
	return (
		<section
			data-agent-runtime-guide
			aria-label={t("agent.runtime.title")}
			className={cn(
				"rounded-lg border bg-muted/20 p-3 text-xs",
				needsAttention && "border-amber-500/35 bg-amber-500/5",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium">{t("agent.runtime.title")}</p>
					<div
						role="status"
						aria-live="polite"
						className="mt-1 flex items-center gap-1.5 text-muted-foreground"
					>
						{checking ? (
							<LoaderCircle
								className="size-3.5 shrink-0 animate-spin"
								aria-hidden
							/>
						) : needsAttention ? (
							<TriangleAlert
								className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
								aria-hidden
							/>
						) : report ? (
							<CheckCircle2
								className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
								aria-hidden
							/>
						) : null}
						<span>{t(`agent.runtime.${statusKey}`)}</span>
					</div>
				</div>
				{recheckButton}
			</div>
			{report && (
				<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
					{(["node", "npm"] as const).map((name) => (
						<div key={name} className="flex min-w-0 items-baseline gap-2">
							<dt>{name === "node" ? "Node.js" : "npm"}</dt>
							<dd
								className={cn(
									"break-all text-muted-foreground",
									report[name].status !== "available" &&
										"text-amber-700 dark:text-amber-300",
								)}
							>
								{report[name].status === "available" && report[name].version
									? report[name].version
									: t(`doctor.host.toolStatus.${report[name].status}`)}
							</dd>
						</div>
					))}
				</dl>
			)}
			{needsAttention && (
				<p className="mt-2 leading-relaxed text-amber-800 dark:text-amber-200">
					{t("agent.runtime.warning")}
				</p>
			)}
			<details className="mt-2" open={needsAttention || !report}>
				<summary className="cursor-pointer rounded-sm py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
					{t("agent.runtime.guide")}
				</summary>
				<div className="mt-1 space-y-2 leading-relaxed text-muted-foreground">
					<p>{t("agent.runtime.description")}</p>
					<ol className="list-decimal space-y-1 pl-4">
						<li>{t("agent.runtime.install")}</li>
						<li>{t("agent.runtime.afterInstall")}</li>
					</ol>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => openExternalUrl("https://nodejs.org/en/download")}
					>
						<ExternalLink data-icon="inline-start" aria-hidden />
						{t("agent.runtime.download")}
					</Button>
				</div>
			</details>
		</section>
	);
});
