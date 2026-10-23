/**
 * Bridge-message → selection toolbar for proxied web papers.
 *
 * The page inside the iframe is cross-origin by construction; its injected
 * bridge (`features/web/proxy.rs`) reports selections / shortcuts / external
 * links over postMessage, and this hook turns them into the same floating
 * chrome the PDF and plaza surfaces have: auto-copy + toolbar, ephemeral
 * streaming translate card, ⌘K / ⌘L quotation into the full Agent. No marks —
 * web papers have no marks/ sidecar (known limitation, docs/frontend/web-view).
 */

import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import {
	bridgeSelectionBottomRight,
	bridgeSelectionScreen,
	parseWebBridgeMessage,
} from "@/components/viewer/web-view/bridge-message";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { registerSelectionAgentAction } from "@/lib/agent/selection-agent-action";
import {
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { openExternalUrl } from "@/lib/core/open-external";
import { createTranslateRecord } from "@/lib/pdf/translate";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { openRightTab } from "@/lib/shell/ui-window-actions";
import {
	type SelectionTranslation,
	translateWebSelection,
} from "@/lib/translate/selection";
import { webViewProxyOrigins } from "@/lib/web-view/proxy-url";

const COPIED_LABEL_DURATION_MS = 1000;

export type WebViewSelectionMenu = {
	text: string;
	screen: ScreenPoint;
	/** Selection bottom-right corner — where the translate card opens. */
	bottomRight: ScreenPoint;
};

/** Message the app sends into the frame (`source` marker the bridge checks). */
function postToFrame(
	iframe: HTMLIFrameElement | null,
	type: "clearSelection" | "copySelection",
) {
	iframe?.contentWindow?.postMessage({ source: "edda-web-host", type }, "*");
}

export function useWebViewSelection({
	srcUrl,
	iframeRef,
}: {
	/** The real remote URL (also the ask/translate provenance). */
	srcUrl: string;
	iframeRef: RefObject<HTMLIFrameElement | null>;
	title?: string;
}) {
	const [menu, setMenu] = useState<WebViewSelectionMenu | null>(null);
	const [copiedLabelPos, setCopiedLabelPos] = useState<ScreenPoint | null>(
		null,
	);
	const labelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Ephemeral single translate card (no marks/ to write into).
	const [translateRec, setTranslateRec] = useState<PdfTranslateRecord | null>(
		null,
	);
	const [translateScreen, setTranslateScreen] = useState<ScreenPoint | null>(
		null,
	);
	const [translateStreaming, setTranslateStreaming] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);
	const translationRef = useRef<SelectionTranslation | null>(null);

	const clearCopiedLabel = useCallback(() => {
		if (labelTimerRef.current) {
			clearTimeout(labelTimerRef.current);
			labelTimerRef.current = null;
		}
		setCopiedLabelPos(null);
	}, []);

	const closeMenu = useCallback(() => {
		setMenu(null);
		clearCopiedLabel();
	}, [clearCopiedLabel]);

	// New page → drop selection chrome (covers in-frame navigations too:
	// the reload re-runs the bridge but not this React tree).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on page navigation
	useEffect(() => {
		setMenu(null);
		setTranslateRec(null);
		setTranslateScreen(null);
		setTranslateError(null);
		clearCopiedLabel();
	}, [srcUrl, clearCopiedLabel]);

	// Stop a running translation when the viewer goes away.
	useEffect(() => () => translationRef.current?.cancel(), []);

	const stopTranslateSession = useCallback(() => {
		translationRef.current?.cancel();
		translationRef.current = null;
		setTranslateStreaming(false);
	}, []);

	const handleAddToChat = useCallback(() => {
		if (!menu) return;
		const text = menu.text;
		setMenu(null);
		clearCopiedLabel();
		// Focus sits in the frame; ask its bridge to clear the selection.
		postToFrame(iframeRef.current, "clearSelection");
		publishSelection({
			text,
			sourcePath: srcUrl,
			origin: "markdown",
		});
		pinActiveSelection();
		openRightTab("agent");
		focusAgentComposer();
	}, [menu, srcUrl, iframeRef, clearCopiedLabel]);

	const handleTranslate = useCallback(() => {
		if (!menu) return;
		const quote = menu.text;
		// Anchor below-right of the selection: SelectionCard opens to the right
		// of (or right-aligned under) the anchor, and `trackPin` places its top
		// 8px above the anchor — +8 lands it right under the selected text.
		const screen = {
			x: menu.bottomRight.x,
			y: menu.bottomRight.y + 8,
		};
		setMenu(null);
		clearCopiedLabel();

		stopTranslateSession();
		const rec = createTranslateRecord({
			paperPath: srcUrl,
			page: 1,
			rects: [],
			quote,
		});
		setTranslateRec(rec);
		setTranslateScreen(screen);
		setTranslateStreaming(true);
		setTranslateError(null);

		const update = (patch: Partial<PdfTranslateRecord>) =>
			setTranslateRec((prev) =>
				prev && prev.id === rec.id
					? { ...prev, ...patch, updatedAt: new Date().toISOString() }
					: prev,
			);
		translationRef.current = translateWebSelection({
			text: quote,
			sourceKey: srcUrl,
			onText: (result) => update({ result, error: undefined }),
			onError: (error) => update({ error }),
			onSettled: () => setTranslateStreaming(false),
		});
	}, [menu, srcUrl, stopTranslateSession, clearCopiedLabel]);

	const hideTranslate = useCallback(() => {
		stopTranslateSession();
		setTranslateRec(null);
		setTranslateScreen(null);
		setTranslateError(null);
	}, [stopTranslateSession]);

	// ⌘K quotes into the Agent while the web toolbar is armed. ⌘L arrives
	// from the bridge (keyboard focus never leaves the frame).
	const menuRef = useRef(menu);
	menuRef.current = menu;
	const handleAddToChatRef = useRef(handleAddToChat);
	handleAddToChatRef.current = handleAddToChat;
	useEffect(() => {
		return registerSelectionAgentAction(() => {
			if (!menuRef.current) return false;
			handleAddToChatRef.current();
			return true;
		});
	}, []);

	// Bridge messages: selections position the toolbar, scroll hides it,
	// shortcuts trigger the actions, external links go to the system browser.
	useEffect(() => {
		const origins = webViewProxyOrigins();
		const onMessage = (event: MessageEvent) => {
			if (!origins.includes(event.origin)) return;
			const msg = parseWebBridgeMessage(event.data);
			if (!msg) return;
			switch (msg.type) {
				case "selection": {
					const iframe = iframeRef.current;
					if (!iframe) return;
					if (!msg.text || !msg.rect) {
						setMenu(null);
						return;
					}
					const ir = iframe.getBoundingClientRect();
					const screen = bridgeSelectionScreen(msg.rect, ir);
					setMenu({
						text: msg.text,
						screen,
						bottomRight: bridgeSelectionBottomRight(msg.rect, ir),
					});
					// The bridge already execCommand-copied inside the frame; the
					// app-side write can be refused while focus sits there — try
					// anyway so the label only shows on a real copy.
					void copyTextToClipboard(msg.text);
					clearCopiedLabel();
					setCopiedLabelPos(screen);
					labelTimerRef.current = setTimeout(() => {
						labelTimerRef.current = null;
						setCopiedLabelPos(null);
					}, COPIED_LABEL_DURATION_MS);
					return;
				}
				case "scroll":
					setMenu(null);
					return;
				case "shortcut":
					handleAddToChatRef.current();
					return;
				case "external":
					openExternalUrl(msg.url);
					return;
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [iframeRef, clearCopiedLabel]);

	return {
		menu,
		translateRec,
		translateScreen,
		translateStreaming,
		translateError,
		copiedLabelPos,
		closeMenu,
		handleAddToChat,
		handleTranslate,
		hideTranslate,
		deleteTranslateCard: hideTranslate,
		openTranslateSettings: () => openSettingsWindow("translate"),
	};
}
