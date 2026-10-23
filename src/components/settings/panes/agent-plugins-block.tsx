import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	HelpLabel,
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
	settingsRowClassName,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	mcpServerTarget,
	mergeMcpServers,
	parseMcpServers,
} from "@/lib/agent/mcp-plugins";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import type { AppSettings } from "@/lib/settings";

/**
 * MCP servers handed to every local agent session ("plugins"). Paste a URL or
 * the JSON block from a server's README; each row toggles or removes one.
 */
export function AgentPluginsBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const servers = settings.agentMcpServers;
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");

	const add = () => {
		const parsed = parseMcpServers(draft);
		if (!parsed) {
			notifyError(t("network.plugins.invalid"));
			return;
		}
		patch({ agentMcpServers: mergeMcpServers(servers, parsed) });
		notifySuccess(t("network.plugins.added", { count: parsed.length }));
		setDraft("");
		setAdding(false);
	};

	return (
		<>
			<SettingsSectionLabel>
				<HelpLabel
					label={t("network.sections.plugins")}
					help={t("network.plugins.help")}
				/>
			</SettingsSectionLabel>
			<SettingsGroup>
				{servers.map((server) => (
					<SettingsRow
						key={server.name}
						htmlFor={`agent-plugin-${server.name}`}
						label={
							<span className="flex min-w-0 flex-col">
								<span className="truncate">{server.name}</span>
								<span className="truncate font-mono text-muted-foreground text-xs">
									{mcpServerTarget(server)}
								</span>
							</span>
						}
					>
						<Switch
							id={`agent-plugin-${server.name}`}
							checked={server.enabled !== false}
							onCheckedChange={(enabled) =>
								patch({
									agentMcpServers: servers.map((item) =>
										item.name === server.name ? { ...item, enabled } : item,
									),
								})
							}
						/>
						<Button
							type="button"
							size="icon-xs"
							variant="ghost"
							aria-label={t("common:remove")}
							title={t("common:remove")}
							onClick={() =>
								patch({
									agentMcpServers: servers.filter(
										(item) => item.name !== server.name,
									),
								})
							}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</SettingsRow>
				))}
				{adding ? (
					<div className="flex flex-col gap-2 px-4 py-3">
						<Textarea
							autoFocus
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							placeholder={t("network.plugins.placeholder")}
							rows={5}
							spellCheck={false}
							className="font-mono text-xs"
						/>
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => {
									setAdding(false);
									setDraft("");
								}}
							>
								{t("common:cancel")}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!draft.trim()}
								onClick={add}
							>
								{t("network.plugins.add")}
							</Button>
						</div>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setAdding(true)}
						className={cn(
							settingsRowClassName,
							"w-full justify-start gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground",
						)}
					>
						<Plus className="size-3.5" aria-hidden />
						{t("network.plugins.add")}
					</button>
				)}
			</SettingsGroup>
		</>
	);
}
