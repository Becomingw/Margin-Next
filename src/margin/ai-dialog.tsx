import { Bot, ChevronDown, Copy, Loader2, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { errorMessage, notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { workspaceStore } from "@/lib/workspace/store";
import {
	type AiStatus,
	aiStatus,
	decideProposal,
	type ProposalDetail,
	proposalDetail,
	proposalUpdates,
	startAi,
	stopAi,
	type UpdatePage,
} from "./ai-client";

const button =
	"inline-flex h-8 items-center justify-center gap-2 rounded-md border border-input px-3 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
export function MarginAiDialog({
	root,
	reviewId,
	onBusyChange,
}: {
	root: string;
	reviewId: string;
	onBusyChange: (busy: boolean) => void;
}) {
	const { t } = useTranslation("margin");
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const epoch = useRef(0);
	const [status, setStatus] = useState<AiStatus | null>(null);
	const [page, setPage] = useState<UpdatePage | null>(null);
	const [preview, setPreview] = useState<ProposalDetail | null>(null);
	const selected = useRef<string | null>(null);
	const [name, setName] = useState(t("ai.defaultName"));
	const dirty = useStore(workspaceStore, (s) =>
		s.tabs.some((tab) => tab.reviewId === reviewId && tab.markdownDirty),
	);
	const refresh = useCallback(async () => {
		const ticket = epoch.current;
		const pid = selected.current;
		const [connection, updates, detail] = await Promise.all([
			aiStatus(),
			proposalUpdates(root, reviewId),
			pid ? proposalDetail(root, reviewId, pid) : Promise.resolve(null),
		]);
		if (ticket !== epoch.current) return;
		setStatus(connection);
		setPage((previous) =>
			previous && previous.sequence > updates.sequence ? previous : updates,
		);
		if (pid === selected.current) setPreview(detail);
	}, [root, reviewId]);
	useEffect(() => {
		void refresh().catch(() => {});
		const timer = window.setInterval(() => {
			if (!busyRef.current && document.visibilityState === "visible")
				void refresh().catch(() => {});
		}, 1500);
		return () => {
			epoch.current++;
			window.clearInterval(timer);
		};
	}, [refresh]);
	const run = async (action: () => Promise<unknown>) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		onBusyChange(true);
		epoch.current++;
		try {
			await action();
			await refresh();
		} catch (e) {
			notifyError(errorMessage(e));
			void refresh().catch(() => {});
		} finally {
			busyRef.current = false;
			setBusy(false);
			onBusyChange(false);
		}
	};
	const copyConfiguration = async () => {
		try {
			await navigator.clipboard.writeText(
				JSON.stringify(status?.config, null, 2),
			);
		} catch (e) {
			notifyError(errorMessage(e));
		}
	};
	const connected = Boolean(
		status?.listening &&
			status.reviewId === reviewId &&
			status.workspacePath === root,
	);
	const pending = page?.proposals ?? [];
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!busyRef.current) {
					setOpen(value);
					if (value) void refresh().catch((e) => notifyError(errorMessage(e)));
				}
			}}
		>
			<DialogTrigger asChild>
				<button
					type="button"
					className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					aria-label={t("ai.title")}
					title={t("ai.title")}
					aria-pressed={connected}
				>
					<Bot size={16} aria-hidden />
					{pending.length > 0 ? (
						<span className="text-xs tabular-nums">{pending.length}</span>
					) : null}
				</button>
			</DialogTrigger>
			<DialogContent
				className="flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-2xl"
				showCloseButton={!busy}
				onEscapeKeyDown={(e) => {
					if (busy) e.preventDefault();
				}}
				onInteractOutside={(e) => {
					if (busy) e.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("ai.title")}</DialogTitle>
					<DialogDescription>{t("ai.description")}</DialogDescription>
				</DialogHeader>
				<div className="edda-scroll min-h-0 space-y-5 overflow-y-auto">
					<section className="space-y-3">
						<div className="flex flex-wrap items-end gap-2">
							<label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
								{t("ai.name")}
								<input
									value={connected ? (status?.label ?? name) : name}
									disabled={busy || connected}
									onChange={(e) => setName(e.target.value)}
									maxLength={80}
									className="h-8 w-full rounded-md border border-input bg-background px-2 text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
								/>
							</label>
							<button
								type="button"
								className={button}
								disabled={busy || (!connected && !name.trim())}
								onClick={() =>
									void run(async () => {
										setStatus(
											connected
												? await stopAi()
												: await startAi(root, reviewId, name),
										);
									})
								}
							>
								{busy ? (
									<Loader2
										size={14}
										className="animate-spin motion-reduce:animate-none"
										aria-hidden
									/>
								) : connected ? (
									<Unplug size={14} aria-hidden />
								) : (
									<Bot size={14} aria-hidden />
								)}
								{t(connected ? "ai.disconnect" : "ai.enable")}
							</button>
						</div>
						<p role="status" className="text-muted-foreground text-xs">
							{t(connected ? "ai.connected" : "ai.offline")}
						</p>
						{connected && status?.config ? (
							<details className="rounded-lg border bg-card p-4">
								<summary className="cursor-pointer text-xs font-medium">
									{t("ai.configuration")}
								</summary>
								<div className="mt-3 flex items-start gap-2">
									<textarea
										aria-label={t("ai.configuration")}
										readOnly
										spellCheck={false}
										rows={7}
										value={JSON.stringify(status.config, null, 2)}
										onFocus={(e) => e.currentTarget.select()}
										className="min-w-0 flex-1 resize-y rounded-md border border-input bg-background p-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring"
									/>
									<button
										type="button"
										className={cn(button, "w-8 shrink-0 px-0")}
										aria-label={t("ai.copy")}
										title={t("ai.copy")}
										onClick={() => void copyConfiguration()}
									>
										<Copy size={14} aria-hidden />
									</button>
								</div>
								<p className="mt-2 text-xs text-muted-foreground">
									{t("ai.credentialHint")}
								</p>
							</details>
						) : null}
					</section>
					<section className="space-y-3 border-t border-hairline-soft pt-4">
						<h2 className="font-medium text-sm">
							{t("ai.proposals")}{" "}
							<span className="text-muted-foreground tabular-nums">
								{pending.length}
							</span>
						</h2>
						{pending.length === 0 ? (
							<p className="text-xs text-muted-foreground">{t("ai.empty")}</p>
						) : (
							pending.map((proposal) => (
								<article
									key={proposal.id}
									data-margin-proposal-id={proposal.id}
									className="rounded-lg border bg-card p-4"
								>
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded-md text-left text-xs focus-visible:ring-2 focus-visible:ring-ring"
										disabled={busy}
										aria-expanded={preview?.id === proposal.id}
										onClick={() =>
											void run(async () => {
												selected.current =
													selected.current === proposal.id ? null : proposal.id;
												setPreview(null);
											})
										}
									>
										<Bot size={14} aria-hidden />
										<span className="min-w-0 flex-1 truncate font-medium">
											{proposal.agent ?? t("ai.defaultName")}
										</span>
										<span className="font-mono text-muted-foreground">
											{proposal.id.slice(-8)}
										</span>
										<ChevronDown size={14} aria-hidden />
									</button>
									{preview?.id === proposal.id ? (
										<div className="mt-3 space-y-3">
											<pre
												className="edda-scroll max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed"
												title={t("ai.preview")}
											>
												{preview.preview.split("\n").map((line, index) => (
													<span
														// biome-ignore lint/suspicious/noArrayIndexKey: immutable, stateless diff lines have no persistent row state.
														key={`${index}-${line}`}
														className={cn(
															"block",
															line.startsWith("+")
																? "text-review-insert"
																: line.startsWith("-")
																	? "text-review-delete"
																	: "text-muted-foreground",
														)}
													>
														{line || " "}
													</span>
												))}
											</pre>
											{preview.truncated ? (
												<p className="text-xs text-muted-foreground">
													{t("ai.truncated")}
												</p>
											) : null}
											{!preview.baseMatchesHead ? (
												<p className="text-xs text-muted-foreground">
													{t("ai.stale")}
												</p>
											) : dirty ? (
												<p className="text-xs text-muted-foreground">
													{t("pending")}
												</p>
											) : null}
											<div className="flex flex-wrap gap-2">
												<button
													type="button"
													className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-primary-foreground text-xs focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
													disabled={busy || dirty || !preview.baseMatchesHead}
													onClick={() =>
														void run(async () => {
															await decideProposal(
																root,
																reviewId,
																proposal.id,
																page?.sequence ?? preview.sequence,
																"apply",
															);
															selected.current = null;
															setPreview(null);
														})
													}
												>
													{t("ai.apply")}
												</button>
												<button
													type="button"
													className={button}
													disabled={busy}
													onClick={() =>
														void run(async () => {
															await decideProposal(
																root,
																reviewId,
																proposal.id,
																page?.sequence ?? preview.sequence,
																"dismiss",
															);
															selected.current = null;
															setPreview(null);
														})
													}
												>
													{t("ai.dismiss")}
												</button>
											</div>
										</div>
									) : null}
								</article>
							))
						)}
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
