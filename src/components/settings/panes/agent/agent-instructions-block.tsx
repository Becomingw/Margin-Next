import { FilePenLine, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import {
	readAgentInstructions,
	saveAgentInstructions,
} from "@/lib/agent/vault-config";
import type { InstructionsFile } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

type PendingSave = {
	vault: string;
	content: string;
	original: InstructionsFile;
};

export function AgentInstructionsBlock({
	vaultPath,
	vaultLabel,
}: {
	vaultPath: string | null;
	vaultLabel?: string;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [original, setOriginal] = useState<InstructionsFile | null>(null);
	const [content, setContent] = useState("");
	const [pending, setPending] = useState<PendingSave | null>(null);
	const owner = useRef(vaultPath);
	owner.current = vaultPath;
	const epoch = useRef(0);
	const saveBusy = useRef(false);
	const label =
		vaultLabel || vaultPath?.split(/[\\/]/).filter(Boolean).pop() || "";
	const dismiss = () => {
		if (!saveBusy.current) {
			if (pending) setPending(null);
			else setOpen(false);
		}
	};
	useOverlayRegistration("agent-instructions", open, dismiss);
	// biome-ignore lint/correctness/useExhaustiveDependencies: vault changes invalidate the editor and any pending save.
	useEffect(() => {
		epoch.current++;
		saveBusy.current = false;
		setSaving(false);
		setOpen(false);
		setPending(null);
		setOriginal(null);
	}, [vaultPath]);
	useEffect(() => {
		if (!open || !vaultPath) return;
		let cancelled = false;
		setLoading(true);
		setOriginal(null);
		void readAgentInstructions(vaultPath)
			.then((file) => {
				if (!cancelled) {
					setOriginal(file);
					setContent(file.content);
				}
			})
			.catch((error) => {
				if (!cancelled) notifyError(errorText(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, vaultPath]);
	const save = async () => {
		if (!pending || saveBusy.current || owner.current !== pending.vault) return;
		const snapshot = pending;
		const token = epoch.current;
		saveBusy.current = true;
		setSaving(true);
		try {
			const result = await saveAgentInstructions(
				snapshot.vault,
				snapshot.content,
				snapshot.original,
				true,
			);
			if (owner.current === snapshot.vault && epoch.current === token) {
				setOriginal(result);
				setOpen(false);
				notifySuccess(t("agent.instructions.saved"));
			}
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			if (epoch.current === token) {
				saveBusy.current = false;
				setSaving(false);
			}
		}
	};
	return (
		<>
			<SettingsGroup>
				<div className="flex items-center justify-between gap-3 px-3.5 py-3">
					<div className="min-w-0">
						<p className="font-medium text-sm">
							{t("agent.instructions.title")}
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							{vaultPath
								? t("agent.instructions.scope", { name: label })
								: t("agent.instructions.noVault")}
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={!vaultPath || !isTauri()}
						onClick={() => {
							setPending(null);
							setOpen(true);
						}}
					>
						<FilePenLine className="size-3.5" />
						{t("agent.instructions.edit")}
					</Button>
				</div>
			</SettingsGroup>
			<Dialog
				open={open}
				onOpenChange={(value) => {
					if (!value) dismiss();
				}}
			>
				<DialogContent className="max-h-[90vh] w-[min(48rem,calc(100vw-2rem))] max-w-none sm:max-w-none">
					{pending ? (
						<>
							<DialogHeader>
								<DialogTitle>
									{t("agent.instructions.confirmTitle")}
								</DialogTitle>
								<DialogDescription>
									{t("agent.instructions.confirmDescription", { name: label })}
								</DialogDescription>
							</DialogHeader>
							<pre className="edda-scroll max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">
								{pending.content}
							</pre>
							<DialogFooter>
								<Button
									variant="outline"
									disabled={saving}
									onClick={() => setPending(null)}
								>
									{t("agent.instructions.back")}
								</Button>
								<Button disabled={saving} onClick={() => void save()}>
									{saving && <Loader2 className="size-4 animate-spin" />}
									{t("agent.instructions.confirmSave")}
								</Button>
							</DialogFooter>
						</>
					) : (
						<>
							<DialogHeader>
								<DialogTitle>{t("agent.instructions.title")}</DialogTitle>
								<DialogDescription>
									{t("agent.instructions.scope", { name: label })}
								</DialogDescription>
							</DialogHeader>
							{loading ? (
								<div className="flex h-64 items-center justify-center">
									<Loader2 className="size-5 animate-spin" />
								</div>
							) : (
								<Textarea
									aria-label={t("agent.instructions.content")}
									value={content}
									onChange={(event) => setContent(event.target.value)}
									disabled={!original || saving}
									className="h-[min(55vh,28rem)] resize-none font-mono text-xs leading-relaxed"
									spellCheck={false}
								/>
							)}
							<DialogFooter className="gap-2 sm:justify-between">
								<Button
									type="button"
									variant="ghost"
									disabled={
										!original || saving || content === original?.defaultContent
									}
									onClick={() => {
										if (original) setContent(original.defaultContent);
									}}
								>
									<RotateCcw className="size-3.5" />
									{t("agent.instructions.reset")}
								</Button>
								<div className="flex justify-end gap-2">
									<Button
										type="button"
										variant="ghost"
										disabled={saving}
										onClick={() => setOpen(false)}
									>
										{t("common:cancel")}
									</Button>
									<Button
										type="button"
										disabled={
											!vaultPath ||
											!original ||
											saving ||
											(content === original.content &&
												original.revision !== null)
										}
										onClick={() => {
											if (vaultPath && original)
												setPending({ vault: vaultPath, content, original });
										}}
									>
										{t("common:save")}
									</Button>
								</div>
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
