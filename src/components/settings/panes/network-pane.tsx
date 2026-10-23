import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	GitHubMirrorRow,
	NetworkProxyRow,
} from "@/components/settings/agent-common-rows";
import { AgentPluginsBlock } from "@/components/settings/panes/agent-plugins-block";
import {
	ServerPortRow,
	useLocalServer,
} from "@/components/settings/panes/local-server";
import { McpSettingsBlock } from "@/components/settings/panes/mcp-settings-block";
import {
	HelpLabel,
	PageTitle,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import type { SettingsHostContext } from "@/components/settings/types";
import { Switch } from "@/components/ui/switch";
import { commands, events } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import {
	connectorGetStatus,
	connectorSetEnabled,
	connectorSetPort,
} from "@/lib/paper/import/connector";
import type { AppSettings } from "@/lib/settings";
import { DEFAULT_NETWORK_PROXY_URL } from "@/lib/settings/defaults";

/** Proxy and mirror, plus the local servers other apps connect to. */
export function NetworkPane({
	settings,
	patch,
	hostContext,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	hostContext: SettingsHostContext;
}) {
	const { t } = useTranslation("settings");
	const [proxyUrlDraft, setProxyUrlDraft] = useState(settings.networkProxyUrl);
	// OS system proxy detected by the Host (Windows "Internet Settings"); used
	// automatically while the app proxy is off — surface it for transparency.
	const [systemProxy, setSystemProxy] = useState<string | null>(null);

	useEffect(() => {
		setProxyUrlDraft(settings.networkProxyUrl);
	}, [settings.networkProxyUrl]);

	useEffect(() => {
		if (!isTauri()) return;
		let cancelled = false;
		void callApi(() => commands.networkSystemProxy())
			.then((p) => {
				if (!cancelled) setSystemProxy(p ?? null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<>
			<PageTitle title={t("network.title")} />
			<SettingsSectionLabel>
				{t("network.sections.network")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<NetworkProxyRow
					htmlFor="network-proxy-enabled"
					label={t("general.networkProxy.label")}
					description={
						!settings.networkProxyEnabled && systemProxy
							? t("general.networkProxy.systemDetected", {
									url: systemProxy,
								})
							: undefined
					}
					proxyUrl={proxyUrlDraft}
					proxyEnabled={settings.networkProxyEnabled}
					onProxyUrlChange={setProxyUrlDraft}
					onCommitProxyUrl={() =>
						patch({
							networkProxyUrl:
								proxyUrlDraft.trim() || DEFAULT_NETWORK_PROXY_URL,
						})
					}
					onToggleProxy={(networkProxyEnabled) =>
						patch({ networkProxyEnabled })
					}
				/>
				<GitHubMirrorRow
					htmlFor="github-mirror-enabled"
					label={t("general.githubMirror.label")}
					description={t("general.githubMirror.description")}
					value={settings.githubMirrorBaseUrl}
					enabled={settings.githubMirrorEnabled}
					onValueChange={(githubMirrorBaseUrl) =>
						patch({ githubMirrorBaseUrl })
					}
					onToggle={(githubMirrorEnabled) => patch({ githubMirrorEnabled })}
				/>
			</SettingsGroup>
			<AgentPluginsBlock settings={settings} patch={patch} />
			<SettingsSectionLabel>
				{t("network.sections.connector")}
			</SettingsSectionLabel>
			<ConnectorSettingsBlock settings={settings} patch={patch} />
			<SettingsSectionLabel>{t("network.sections.mcp")}</SettingsSectionLabel>
			<McpSettingsBlock
				settings={settings}
				patch={patch}
				disabled={hostContext.kind === "remote"}
			/>
		</>
	);
}

function ConnectorSettingsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	const { status, busy, toggle, commitPort } = useLocalServer({
		getStatus: connectorGetStatus,
		setEnabled: connectorSetEnabled,
		setPort: connectorSetPort,
		statusEvent: events.connectorStatus,
		onEnabled: (connectorEnabled) => patch({ connectorEnabled }),
		onPort: (connectorPort) => patch({ connectorPort }),
		invalidPortMessage: t("general.connector.invalidPort"),
	});

	return (
		<SettingsGroup>
			<SettingsRow
				label={
					<HelpLabel
						label={t("general.connector.label")}
						help={t("general.connector.hint")}
					/>
				}
				htmlFor="connector-enabled"
			>
				<Switch
					id="connector-enabled"
					checked={settings.connectorEnabled}
					disabled={busy}
					onCheckedChange={(v) => void toggle(v)}
				/>
			</SettingsRow>
			{settings.connectorEnabled ? (
				<ServerPortRow
					id="connector-port"
					label={t("general.connector.portLabel")}
					port={settings.connectorPort}
					listening={status?.listening ?? false}
					disabled={busy}
					onCommit={(value) => void commitPort(value)}
				/>
			) : null}
		</SettingsGroup>
	);
}
