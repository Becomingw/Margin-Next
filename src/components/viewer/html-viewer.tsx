import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SelectionCopiedLabel } from "@/components/ui/selection-copied-label";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { useWebViewSelection } from "@/components/viewer/web-view/use-web-view-selection";
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { cn } from "@/lib/core/utils";
import { arxivReaderUrl, isArxivHostedUrl } from "@/lib/paper/arxiv";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

type HtmlViewerProps = {
	/** Remote URL only — streamed in a sandboxed iframe (no local download) */
	srcUrl?: string | null;
	/** Paper title for ask-card / prompt context. */
	title?: string;
	className?: string;
};

/** Load-state of the built-in proxy for one paper host. */
type ProxyGate = "pending" | "ready" | "denied";

/**
 * True while an HTML5 drag is in progress: frames then drop hit-testing so
 * dragover reaches dockview drop targets (an iframe swallows drag events).
 */
export function useIframeDragShield(): boolean {
	const [dragShield, setDragShield] = useState(false);
	useEffect(() => {
		const arm = () => setDragShield(true);
		const disarm = () => setDragShield(false);
		// Capture phase: see tree/OS drags before the event enters the iframe.
		window.addEventListener("dragstart", arm, true);
		window.addEventListener("dragend", disarm, true);
		window.addEventListener("drop", disarm, true);
		return () => {
			window.removeEventListener("dragstart", arm, true);
			window.removeEventListener("dragend", disarm, true);
			window.removeEventListener("drop", disarm, true);
		};
	}, []);
	return dragShield;
}

/**
 * HTML paper viewer — remote page in a sandboxed iframe.
 * Does not fetch or cache HTML into the vault.
 *
 * arXiv pages keep their dedicated reader proxy; every other host is served
 * through the generic `edda-web` proxy (host allowlisted via the Host
 * command first), which injects the selection bridge the toolbar below needs.
 */
export function HtmlViewer({ srcUrl, title, className }: HtmlViewerProps) {
	const { t } = useTranslation("viewer");
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const dragShield = useIframeDragShield();
	const [gate, setGate] = useState<ProxyGate>("pending");

	const remote = srcUrl && /^https?:\/\//i.test(srcUrl) ? srcUrl : null;
	const trusted = remote ? isArxivHostedUrl(remote) : false;

	// Ensure the host may be served before the frame points at the proxy —
	// the proxy answers 403 otherwise.
	useEffect(() => {
		if (!remote || trusted) return;
		let cancelled = false;
		setGate("pending");
		void (async () => {
			let host = "";
			try {
				host = new URL(remote).hostname;
			} catch {
				if (!cancelled) setGate("denied");
				return;
			}
			try {
				const accepted = await callApiResult(() =>
					commands.webProxyAllowHost({ host }),
				);
				if (!cancelled) setGate(accepted ? "ready" : "denied");
			} catch {
				if (!cancelled) setGate("denied");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [remote, trusted]);

	const selection = useWebViewSelection({
		srcUrl: remote ?? "",
		iframeRef,
		title,
	});

	if (!remote) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm",
					className,
				)}
			>
				{t("html.empty")}
			</div>
		);
	}

	const iframeUrl = trusted
		? arxivReaderUrl(remote)
		: gate === "ready"
			? webViewProxyUrl(remote)
			: null;
	const sandbox =
		"allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

	return (
		<div
			className={cn(
				"relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background",
				className,
			)}
		>
			{iframeUrl ? (
				<iframe
					title={t("html.sandboxTitle")}
					src={iframeUrl}
					sandbox={sandbox}
					referrerPolicy="no-referrer-when-downgrade"
					ref={iframeRef}
					className={cn(
						"absolute inset-0 block h-full w-full border-0 bg-background",
						dragShield && "pointer-events-none",
					)}
					style={{ colorScheme: "light dark" }}
				/>
			) : (
				<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
					{gate === "denied" ? t("html.denied") : null}
				</div>
			)}
			{iframeUrl && !trusted
				? createPortal(
						<>
							{selection.menu ? (
								<SelectionMenu
									screen={selection.menu.screen}
									onHighlight={() => undefined}
									onAddToChat={selection.handleAddToChat}
									onTranslate={selection.handleTranslate}
									showHighlight={false}
								/>
							) : null}
							{selection.copiedLabelPos ? (
								<SelectionCopiedLabel
									x={selection.copiedLabelPos.x}
									y={selection.copiedLabelPos.y}
								/>
							) : null}
							{selection.translateRec && selection.translateScreen ? (
								<TranslateCard
									screen={selection.translateScreen}
									result={selection.translateRec.result ?? ""}
									streaming={selection.translateStreaming}
									error={
										selection.translateError ??
										selection.translateRec.error ??
										null
									}
									onOpenSettings={selection.openTranslateSettings}
									onHide={selection.hideTranslate}
									onDelete={selection.deleteTranslateCard}
								/>
							) : null}
						</>,
						document.body,
					)
				: null}
		</div>
	);
}
