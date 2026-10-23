/**
 * Developer mode: system preset skills become editable. Turning it off backs
 * up and restores modified presets of the open vault (listed for confirmation).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import type { AppSettings } from "@/lib/settings";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

type Pending = { enable: true } | { enable: false; modified: string[] };

export function DeveloperModeBlock({
	settings,
	patch,
	vaultPath,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
	vaultPath: string | null;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [pending, setPending] = useState<Pending | null>(null);
	const localVault =
		vaultPath && !isRemoteVaultHandle(vaultPath) ? vaultPath : null;

	const request = async (enable: boolean) => {
		if (enable) {
			setPending({ enable: true });
			return;
		}
		const modified = localVault
			? await callApi(() => commands.presetSkillsModified(localVault)).catch(
					() => [],
				)
			: [];
		setPending({ enable: false, modified });
	};

	const confirm = async () => {
		if (!pending) return;
		setPending(null);
		patch({ developerMode: pending.enable });
		if (pending.enable || !localVault) return;
		try {
			const result = await callApi(() =>
				commands.presetSkillsRestore(localVault),
			);
			if (result.restored.length > 0) {
				notifySuccess(
					t("general.developerMode.restored", {
						count: result.restored.length,
					}),
				);
			}
		} catch (error) {
			notifyError(errorText(error));
		}
	};

	return (
		<>
			<SettingsSectionLabel>
				{t("general.sections.developer")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow
					label={t("general.developerMode.label")}
					description={t("general.developerMode.hint")}
					htmlFor="developer-mode"
				>
					<Switch
						id="developer-mode"
						checked={settings.developerMode}
						onCheckedChange={(enable) => void request(enable)}
					/>
				</SettingsRow>
			</SettingsGroup>
			<Dialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							{pending?.enable
								? t("general.developerMode.enableTitle")
								: t("general.developerMode.disableTitle")}
						</DialogTitle>
						<DialogDescription>
							{pending?.enable
								? t("general.developerMode.enableBody")
								: pending?.modified.length
									? t("general.developerMode.disableBody")
									: t("general.developerMode.disableNone")}
						</DialogDescription>
					</DialogHeader>
					{pending && !pending.enable && pending.modified.length > 0 ? (
						<ul className="list-disc space-y-0.5 pl-5 font-mono text-caption text-muted-foreground">
							{pending.modified.map((id) => (
								<li key={id}>{id}</li>
							))}
						</ul>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setPending(null)}
						>
							{t("common:cancel")}
						</Button>
						<Button type="button" onClick={() => void confirm()}>
							{t("general.developerMode.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
