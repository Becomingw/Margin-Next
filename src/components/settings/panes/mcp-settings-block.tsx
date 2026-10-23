import {
	ChevronRight,
	Copy,
	ExternalLink,
	LoaderCircle,
	Power,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ServerPortRow,
	useLocalServer,
} from "@/components/settings/panes/local-server";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { StatusDot } from "@/components/settings/status-dot";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { events } from "@/lib/core/bindings";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { mcpGetStatus, mcpSetEnabled, mcpSetPort } from "@/lib/mcp/status";
import {
	type McpTunnelPhase,
	type McpTunnelStatus,
	mcpTunnelStart,
	mcpTunnelStatus,
	mcpTunnelStop,
} from "@/lib/mcp/tunnel";
import type { AppSettings } from "@/lib/settings";

/** Loopback MCP server: switch, then port / URL and the ChatGPT tunnel once on. */
export function McpSettingsBlock({
	settings,
	patch,
	disabled,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	disabled: boolean;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const { status, busy, toggle, commitPort } = useLocalServer({
		getStatus: mcpGetStatus,
		setEnabled: mcpSetEnabled,
		setPort: mcpSetPort,
		statusEvent: events.mcpStatus,
		onEnabled: (mcpEnabled) => patch({ mcpEnabled }),
		onPort: (mcpPort) => patch({ mcpPort }),
		invalidPortMessage: t("general.mcp.invalidPort"),
	});

	const url = status?.url ?? null;

	return (
		<>
			<SettingsGroup>
				<SettingsRow label={t("general.mcp.label")} htmlFor="mcp-enabled">
					<Switch
						id="mcp-enabled"
						checked={settings.mcpEnabled}
						disabled={busy || disabled}
						onCheckedChange={(v) => void toggle(v)}
					/>
				</SettingsRow>
				{settings.mcpEnabled ? (
					<ServerPortRow
						id="mcp-port"
						label={t("general.mcp.portLabel")}
						port={settings.mcpPort}
						listening={status?.listening ?? false}
						disabled={busy || disabled}
						onCommit={(value) => void commitPort(value)}
					>
						{url ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-8"
										aria-label={t("general.mcp.copyUrl")}
										onClick={() =>
											void copyTextToClipboard(url, {
												successMessage: t("general.mcp.copied"),
											})
										}
									>
										<Copy className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("general.mcp.copyUrl")}</TooltipContent>
							</Tooltip>
						) : null}
					</ServerPortRow>
				) : null}
			</SettingsGroup>
			{settings.mcpEnabled ? (
				<Collapsible>
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className="group mb-2 flex items-center gap-1 px-1 text-muted-foreground text-xs outline-none transition-colors hover:text-foreground"
						>
							<ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
							{t("network.advanced")}
						</button>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<SettingsGroup>
							<McpTunnelRows
								settings={settings}
								patch={patch}
								disabled={disabled || busy}
								mcpListening={status?.listening ?? false}
								mcpUrl={url}
							/>
						</SettingsGroup>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</>
	);
}

const TUNNEL_ID_RE = /^tunnel_[0-9a-f]{32}$/;
const TUNNEL_INSTALL_COMMAND = "brew install openai/tools/tunnel-client";

function tunnelPhaseTone(
	phase: McpTunnelPhase,
): "ok" | "idle" | "warn" | "err" {
	switch (phase) {
		case "ready":
			return "ok";
		case "starting":
			return "warn";
		case "error":
		case "binaryMissing":
			return "err";
		default:
			return "idle";
	}
}

function McpTunnelRows({
	settings,
	patch,
	disabled,
	mcpListening,
	mcpUrl,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	disabled: boolean;
	mcpListening: boolean;
	mcpUrl: string | null;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [status, setStatus] = useState<McpTunnelStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [tunnelIdDraft, setTunnelIdDraft] = useState(settings.mcpTunnelId);
	const [keyDraft, setKeyDraft] = useState(settings.mcpTunnelApiKey);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setStatus(await mcpTunnelStatus());
		} catch {
			// ignore probe failures in settings
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useTauriEvent(events.mcpTunnelStatus, (payload) => {
		setStatus(payload);
	});

	const commitTunnelId = (value: string) => {
		const id = value.trim().toLowerCase().replace(/\s+/g, "");
		setTunnelIdDraft(id);
		if (id && !TUNNEL_ID_RE.test(id)) {
			notifyError(t("general.mcp.tunnel.invalidTunnelId"));
		}
		patch({ mcpTunnelId: id });
	};

	const commitKey = (value: string) => {
		const key = value.trim();
		setKeyDraft(key);
		patch({ mcpTunnelApiKey: key });
	};

	const start = async () => {
		if (!mcpUrl || !isTauri()) return;
		setBusy(true);
		try {
			const next = await mcpTunnelStart(mcpUrl);
			setStatus(next);
			if (next.lastError) {
				notifyError(next.lastError);
			}
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const stop = async () => {
		if (!isTauri()) return;
		setBusy(true);
		try {
			setStatus(await mcpTunnelStop());
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const phase = status?.phase ?? "stopped";
	const running = status?.running ?? false;
	const binaryMissing = phase === "binaryMissing";
	const installCommand = status?.installCommand ?? TUNNEL_INSTALL_COMMAND;

	const phaseLabel = {
		binaryMissing: t("general.mcp.tunnel.binaryMissing"),
		stopped: t("general.mcp.tunnel.stopped"),
		starting: t("general.mcp.tunnel.starting"),
		ready: t("general.mcp.tunnel.ready"),
		error: t("general.mcp.tunnel.error"),
	}[phase];

	return (
		<>
			<SettingsRow
				label={t("general.mcp.tunnel.apiKeyLabel")}
				htmlFor="mcp-tunnel-key"
			>
				<div className="flex items-center gap-2">
					<Input
						id="mcp-tunnel-key"
						type="password"
						autoComplete="off"
						className="h-8 w-full max-w-[18rem] font-mono text-xs"
						value={keyDraft}
						disabled={disabled || running}
						onChange={(e) => setKeyDraft(e.currentTarget.value)}
						onBlur={(e) => commitKey(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								commitKey(e.currentTarget.value);
							}
						}}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={t("general.mcp.tunnel.openApiKeys")}
								onClick={() =>
									void openExternalUrl(
										"https://platform.openai.com/settings/organization/api-keys",
									)
								}
							>
								<ExternalLink className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("general.mcp.tunnel.openApiKeys")}
						</TooltipContent>
					</Tooltip>
				</div>
			</SettingsRow>
			<SettingsRow
				label={t("general.mcp.tunnel.tunnelIdLabel")}
				htmlFor="mcp-tunnel-id"
			>
				<div className="flex items-center gap-2">
					<Input
						id="mcp-tunnel-id"
						className="h-8 w-full max-w-[18rem] font-mono text-xs"
						value={tunnelIdDraft}
						disabled={disabled || running}
						onChange={(e) => setTunnelIdDraft(e.currentTarget.value)}
						onBlur={(e) => commitTunnelId(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								commitTunnelId(e.currentTarget.value);
							}
						}}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								aria-label={t("general.mcp.tunnel.openTunnels")}
								onClick={() =>
									void openExternalUrl(
										"https://platform.openai.com/settings/organization/tunnels",
									)
								}
							>
								<ExternalLink className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{t("general.mcp.tunnel.openTunnels")}
						</TooltipContent>
					</Tooltip>
				</div>
			</SettingsRow>
			<SettingsRow label={t("general.mcp.tunnel.label")}>
				<div className="flex items-center gap-2">
					<StatusDot tone={tunnelPhaseTone(phase)} label={phaseLabel} />
					<Button
						type="button"
						size="sm"
						disabled={disabled || busy || binaryMissing || !mcpListening}
						onClick={() => void (running ? stop() : start())}
					>
						{busy ? (
							<LoaderCircle className="mr-1.5 size-4 animate-spin" />
						) : (
							<Power className="mr-1.5 size-4" />
						)}
						{running
							? t("general.mcp.tunnel.stop")
							: t("general.mcp.tunnel.start")}
					</Button>
				</div>
			</SettingsRow>
			{binaryMissing && (
				<div className="px-3 pb-2 text-muted-foreground text-xs">
					<p className="mb-1.5">{t("general.mcp.tunnel.installHint")}</p>
					<div className="flex items-center gap-2">
						<code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-caption">
							{installCommand}
						</code>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label={t("general.mcp.tunnel.copyCommand")}
									onClick={() =>
										void copyTextToClipboard(installCommand, {
											successMessage: t("general.mcp.tunnel.copied"),
										})
									}
								>
									<Copy className="size-3.5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{t("general.mcp.tunnel.copyCommand")}
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
			)}
		</>
	);
}
