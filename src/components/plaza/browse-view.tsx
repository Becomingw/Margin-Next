/**
 * A user-added website under 浏览 (Browse), shown in a native webview that
 * follows this panel. The view keeps its own persistent profile, so sign-ins
 * survive restarts; a handoff frame keeps the page visible beneath app overlays.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	ArrowLeft,
	ArrowRight,
	BookPlus,
	ExternalLink,
	LoaderCircle,
	Puzzle,
	RotateCw,
	WandSparkles,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { encodeSkillToken } from "@/lib/agent/composer-inline-tokens";
import { setPendingAgentComposerPrompt } from "@/lib/agent/composer-seed";
import { registerPageContext } from "@/lib/agent/page-context";
import {
	browsePageSnapshot,
	browseUiLabels,
	browseViewLabel,
	createViewCoverageProbe,
	handleBrowseSelection,
	importFromBrowse,
	normalizeSiteUrl,
	stopBrowseTranslation,
	trackBrowseView,
} from "@/lib/browse/native-view";
import { createBrowsePresentation } from "@/lib/browse/presentation";
import type { AdapterInfo, BrowseSite } from "@/lib/core/bindings";
import { commands, events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult, callResult } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isWindows } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { openRightTab } from "@/lib/shell/ui-window-actions";

function ToolbarButton({
	label,
	onClick,
	pressed,
	children,
}: {
	label: string;
	onClick: () => void;
	/** Toggle buttons: on shows as active. */
	pressed?: boolean;
	children: ReactNode;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={label}
			title={label}
			aria-pressed={pressed}
			className={cn(pressed && "bg-muted text-foreground")}
			onClick={onClick}
		>
			{children}
		</Button>
	);
}

export function BrowseView({
	site,
	path,
	className,
}: {
	site: BrowseSite;
	/** Tab path; the view closes once no tab shows it. */
	path: string;
	className?: string;
}) {
	const { t } = useTranslation("sidebar");
	const hostRef = useRef<HTMLDivElement | null>(null);
	const frameRef = useRef<HTMLImageElement | null>(null);
	const frameOwner = useRef<symbol | null>(null);
	const [label] = useState(() =>
		browseViewLabel(getCurrentWindow().label, site.id),
	);
	const [url, setUrl] = useState(site.url);
	const [address, setAddress] = useState(site.url);
	const [editing, setEditing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [importing, setImporting] = useState(false);
	const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
	const editingRef = useRef(false);
	const selectOnMouseUp = useRef(false);
	editingRef.current = editing;

	useEffect(() => {
		const offPage = events.browsePage.listen(({ payload }) => {
			if (payload.label !== label) return;
			setLoading(payload.loading);
			setUrl(payload.url);
			if (!editingRef.current) setAddress(payload.url);
		});
		const offDownload = events.browseDownload.listen(({ payload }) => {
			if (payload.label !== label) return;
			if (payload.ok) {
				notifySuccess(t("plaza.browse.downloaded", { name: payload.name }));
			} else {
				notifyError(t("plaza.browse.downloadFailed", { name: payload.name }));
			}
		});
		// An adapter's import button on the page.
		const offAction = events.browseAction.listen(({ payload }) => {
			if (payload.label !== label) return;
			if (payload.target) void importFromBrowse(label, payload.target);
			if (payload.selection) handleBrowseSelection(label, payload.selection);
		});
		return () => {
			void offPage.then((off) => off());
			void offDownload.then((off) => off());
			void offAction.then((off) => off());
			stopBrowseTranslation(label);
		};
	}, [label, t]);

	// Create (or reuse) the view, then follow the placeholder every frame:
	// position changes without a resize (sidebar collapse) are caught too.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let opened = false;
		let frame = 0;
		let last = "";
		let dragging = false;
		const snapshots = isWindows();
		const coverage = createViewCoverageProbe(snapshots);
		const image = frameRef.current;
		const owner = Symbol();
		frameOwner.current = owner;
		const presentation = createBrowsePresentation({
			capture: snapshots
				? () => callResult(() => commands.browseSnapshot({ label }))
				: undefined,
			showFrame: async (source) => {
				if (!image || frameOwner.current !== owner) return;
				image.src = source;
				await image.decode();
				if (frameOwner.current !== owner) return;
				image.hidden = false;
				// Paint the decoded frame before asking the Host to hide the native surface.
				await new Promise<void>((resolve) => {
					let raf = 0;
					const done = () => {
						cancelAnimationFrame(raf);
						clearTimeout(timer);
						resolve();
					};
					const timer = window.setTimeout(done, 100);
					raf = requestAnimationFrame(() => {
						raf = requestAnimationFrame(done);
					});
				});
			},
			clearFrame: () => {
				if (image && frameOwner.current === owner) {
					image.hidden = true;
					image.removeAttribute("src");
				}
			},
			setBounds: (rect, visible) =>
				callApiResult(() => commands.browseBounds({ label, rect, visible })),
			onError: (error) => notifyError(errorText(error)),
		});
		const arm = () => {
			dragging = true;
		};
		const disarm = () => {
			dragging = false;
		};
		window.addEventListener("dragstart", arm, true);
		window.addEventListener("dragend", disarm, true);
		window.addEventListener("drop", disarm, true);
		window.addEventListener("blur", disarm);
		const rectOf = () => {
			const box = host.getBoundingClientRect();
			return { x: box.left, y: box.top, width: box.width, height: box.height };
		};
		trackBrowseView(label, path);
		void callApiResult(() =>
			commands.browseOpen({
				label,
				window: getCurrentWindow().label,
				url: site.url,
				rect: rectOf(),
				labels: browseUiLabels(),
			}),
		)
			.then(() => {
				opened = true;
			})
			.catch((error) =>
				notifyError(t("plaza.browse.openFailed"), {
					description: String(error),
				}),
			);
		const tick = () => {
			frame = requestAnimationFrame(tick);
			if (!opened) return;
			const box = host.getBoundingClientRect();
			const visible =
				document.visibilityState === "visible" &&
				box.width > 2 &&
				box.height > 2;
			const covered = visible && (dragging || coverage.isCovered(box));
			const key = `${visible}:${covered}:${Math.round(box.left)}:${Math.round(box.top)}:${Math.round(box.width)}:${Math.round(box.height)}`;
			if (key === last) return;
			last = key;
			presentation.update({
				rect: { x: box.left, y: box.top, width: box.width, height: box.height },
				visible,
				covered,
			});
		};
		frame = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(frame);
			coverage.dispose();
			window.removeEventListener("dragstart", arm, true);
			window.removeEventListener("dragend", disarm, true);
			window.removeEventListener("drop", disarm, true);
			window.removeEventListener("blur", disarm);
			// Switching tabs keeps the page alive; closing the tab closes it.
			presentation.dispose(rectOf());
			if (frameOwner.current === owner) frameOwner.current = null;
		};
	}, [label, path, site.url, t]);

	// The page conversation sees what this view shows.
	useEffect(
		() => registerPageContext(path, () => browsePageSnapshot(label, site.name)),
		[label, path, site.name],
	);

	// In-page navigation (pushState) fires no page event: follow the address.
	useEffect(() => {
		const timer = setInterval(() => {
			if (editingRef.current || document.visibilityState !== "visible") return;
			void commands.browseLocation({ label }).then((at) => {
				if (!at || editingRef.current) return;
				setUrl(at);
				setAddress(at);
			});
		}, 1000);
		return () => clearInterval(timer);
	}, [label]);

	// Adapters covering the page, for the toolbar switch.
	useEffect(() => {
		let live = true;
		void commands.browseAdaptersFor({ url }).then((list) => {
			if (live) setAdapters(list);
		});
		return () => {
			live = false;
		};
	}, [url]);

	const nav = (to: string) => void commands.browseNav({ label, to });

	// Seed this page's conversation with the skill; the user can edit and send.
	const askAgent = (skill: "site-layout" | "site-import", prompt: string) => {
		setPendingAgentComposerPrompt(`${encodeSkillToken(skill)} ${prompt}`);
		openRightTab("agent");
	};

	const importPage = async () => {
		setImporting(true);
		await importFromBrowse(label);
		setImporting(false);
	};

	const adaptersOn = adapters.some((adapter) => adapter.enabled);
	const toggleAdapters = async () => {
		try {
			await callApiResult(() =>
				commands.browseAdapterSetEnabled({
					ids: adapters.map((adapter) => adapter.id),
					enabled: !adaptersOn,
				}),
			);
			setAdapters(await commands.browseAdaptersFor({ url }));
		} catch (error) {
			notifyError(errorText(error));
		}
	};

	return (
		<div
			className={cn(
				"flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
				className,
			)}
		>
			<div className="flex h-8 shrink-0 select-none items-center gap-0.5 border-b px-1.5">
				<ToolbarButton label={t("plaza.back")} onClick={() => nav("back")}>
					<ArrowLeft className="size-3.5" />
				</ToolbarButton>
				<ToolbarButton
					label={t("plaza.forward")}
					onClick={() => nav("forward")}
				>
					<ArrowRight className="size-3.5" />
				</ToolbarButton>
				<ToolbarButton label={t("plaza.reload")} onClick={() => nav("reload")}>
					<RotateCw className={cn("size-3.5", loading && "animate-spin")} />
				</ToolbarButton>
				<form
					className="ml-1 min-w-0 flex-1"
					onSubmit={(event) => {
						event.preventDefault();
						const target = normalizeSiteUrl(address);
						if (!target) {
							notifyError(t("plaza.browse.invalidUrl"));
							return;
						}
						setEditing(false);
						(document.activeElement as HTMLElement | null)?.blur();
						nav(target);
					}}
				>
					<input
						value={address}
						aria-label={t("plaza.browse.address")}
						spellCheck={false}
						className="h-6 w-full truncate rounded-md bg-transparent px-1.5 text-caption text-muted-foreground outline-none focus:bg-muted/70 focus:text-foreground"
						onFocus={(event) => {
							setEditing(true);
							selectOnMouseUp.current = true;
							event.currentTarget.select();
						}}
						// A click focuses and then places the caret on mouse-up, undoing
						// the select-all above; keep the selection like a browser does.
						onMouseUp={(event) => {
							if (!selectOnMouseUp.current) return;
							selectOnMouseUp.current = false;
							event.preventDefault();
						}}
						onBlur={() => {
							setEditing(false);
							setAddress(url);
						}}
						onChange={(event) => setAddress(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") event.currentTarget.blur();
						}}
					/>
				</form>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("plaza.browse.improve")}
							title={t("plaza.browse.improve")}
						>
							<WandSparkles className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							onSelect={() =>
								askAgent("site-layout", t("plaza.browse.layoutPrompt"))
							}
						>
							{t("plaza.browse.optimizeLayout")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() =>
								askAgent("site-import", t("plaza.browse.importPrompt"))
							}
						>
							{t("plaza.browse.makeImportable")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				{adapters.length > 0 && (
					<ToolbarButton
						label={t("plaza.browse.adapter")}
						pressed={adaptersOn}
						onClick={() => void toggleAdapters()}
					>
						<Puzzle className="size-3.5" />
					</ToolbarButton>
				)}
				<ToolbarButton
					label={t("plaza.paperPool.promote")}
					onClick={() => {
						if (!importing) void importPage();
					}}
				>
					{importing ? (
						<LoaderCircle className="size-3.5 animate-spin" />
					) : (
						<BookPlus className="size-3.5" />
					)}
				</ToolbarButton>
				<ToolbarButton
					label={t("plaza.openInSystemBrowser")}
					onClick={() => openExternalUrl(url)}
				>
					<ExternalLink className="size-3.5" />
				</ToolbarButton>
			</div>
			{/* The native webview is drawn over this element. */}
			<div
				ref={hostRef}
				className="relative min-h-0 min-w-0 flex-1 bg-background"
			>
				<img
					ref={frameRef}
					hidden
					alt=""
					aria-hidden="true"
					draggable={false}
					className="pointer-events-none absolute inset-0 h-full w-full select-none"
				/>
			</div>
		</div>
	);
}
