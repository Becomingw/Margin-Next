/**
 * 浏览 (Browse): user websites in native child webviews.
 *
 * A native view is drawn above the page, so the panel only holds a
 * placeholder the view follows (see `components/plaza/browse-view.tsx`).
 * This module owns the pieces that are not React: view labels, site
 * bookkeeping, what may cover a view, and closing views whose tab is gone.
 */

import i18n from "@/i18n";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import type { PageSnapshot } from "@/lib/agent/page-context";
import {
	clearActiveSelection,
	pinActiveSelection,
	publishSelection,
} from "@/lib/agent/selection-store";
import type {
	BrowseImportTarget,
	BrowseSelection,
	BrowseSite,
	BrowseUiLabels,
	PageQuery,
} from "@/lib/core/bindings";
import { commands, events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApiResult } from "@/lib/core/ipc";
import {
	notifyAction,
	notifyError,
	notifySuccess,
	notifyWarning,
} from "@/lib/core/notify";
import { isAnyModalOverlayOpen } from "@/lib/core/overlay-stack";
import { currentLookupParentDir } from "@/lib/paper/library-actions";
import { importPlazaPaper } from "@/lib/plaza/import";
import { browseSitePath } from "@/lib/plaza/sources";
import { getSettings, patchSettings } from "@/lib/settings/react-store";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { openRightTab } from "@/lib/shell/ui-window-actions";
import {
	type SelectionTranslation,
	translateWebSelection,
} from "@/lib/translate/selection";
import { getVaultPath } from "@/lib/vault/store";
import { closeTabsUnderPath } from "@/lib/workspace/actions";
import { workspaceStore } from "@/lib/workspace/store";

/** `browse-<window>-<site>`: one view per site per window. */
export function browseViewLabel(windowLabel: string, siteId: string): string {
	const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, "_");
	return `browse-${safe(windowLabel)}-${safe(siteId)}`;
}

/** `example.org/x` → `https://example.org/x`; null unless it is an http(s) URL. */
export function normalizeSiteUrl(input: string): string | null {
	const text = input.trim();
	if (!text) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
		? text
		: `https://${text}`;
	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (!url.hostname.includes(".") && url.hostname !== "localhost") {
			return null;
		}
		return url.href;
	} catch {
		return null;
	}
}

/** Short readable default name: `www.springer.com` → `springer.com`. */
export function siteNameFromUrl(url: string): string {
	return new URL(url).hostname.replace(/^www\./, "");
}

/** Add a website; returns it, or the existing entry with the same address. */
export function addBrowseSite(url: string, name?: string): BrowseSite {
	const sites = getSettings().browseSites;
	const existing = sites.find((site) => site.url === url);
	if (existing) return existing;
	const site: BrowseSite = {
		id: crypto.randomUUID().slice(0, 8),
		name: name?.trim() || siteNameFromUrl(url),
		url,
	};
	patchSettings({ browseSites: [...sites, site] });
	return site;
}

export function renameBrowseSite(id: string, name: string): void {
	const trimmed = name.trim();
	if (!trimmed) return;
	patchSettings({
		browseSites: getSettings().browseSites.map((site) =>
			site.id === id ? { ...site, name: trimmed } : site,
		),
	});
}

/** Remove a website; closing its tab also closes its native view. */
export function removeBrowseSite(id: string): void {
	closeTabsUnderPath(browseSitePath(id));
	patchSettings({
		browseSites: getSettings().browseSites.filter((site) => site.id !== id),
	});
}

/**
 * Floating app UI the native view would otherwise hide: registered overlays,
 * Radix poppers, menus, listboxes and dialogs that intersect `rect`.
 */
export function isViewCovered(rect: DOMRect): boolean {
	if (isAnyModalOverlayOpen()) return true;
	return layersCoverRect(findCoveringLayers(), rect);
}

function findCoveringLayers(): Element[] {
	return Array.from(
		document.querySelectorAll(
			"[data-radix-popper-content-wrapper], [role='menu'], [role='listbox'], [role='dialog'], [role='alertdialog'], [data-slot='dialog-overlay'], [data-slot='sheet-overlay'], [data-sonner-toast], .dv-context-menu, [data-browse-overlay]",
		),
	);
}

/** Geometry still follows every animation frame, but discovering poppers need
 * not scan the entire editor DOM at 60/120 Hz while the page is idle. */
export function createViewCoverageProbe(includeHints = false): {
	isCovered: (rect: DOMRect) => boolean;
	dispose: () => void;
} {
	let dirty = true;
	let layers: Element[] = [];
	const observer = new MutationObserver(() => {
		dirty = true;
	});
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: [
			"role",
			"data-radix-popper-content-wrapper",
			"data-slot",
			"data-browse-overlay",
			"data-sonner-toast",
		],
	});
	return {
		isCovered: (rect) => {
			if (isAnyModalOverlayOpen()) return true;
			if (dirty) {
				layers = findCoveringLayers();
				dirty = false;
			}
			return layersCoverRect(layers, rect, includeHints);
		},
		dispose: () => {
			observer.disconnect();
			layers = [];
		},
	};
}

function layersCoverRect(
	layers: Iterable<Element>,
	rect: DOMRect,
	includeHints = false,
): boolean {
	for (const layer of layers) {
		// Informational tooltips must not blank an entire native webview.
		// Browse toolbar hints use native title tooltips to avoid airspace overlap.
		if (
			!includeHints &&
			layer.querySelector("[data-slot='tooltip-content'], [role='tooltip']")
		) {
			continue;
		}
		const box = layer.getBoundingClientRect();
		if (
			box.width > 0 &&
			box.left < rect.right &&
			box.right > rect.left &&
			box.top < rect.bottom &&
			box.bottom > rect.top
		) {
			// Mounted-but-invisible PDF cards / popovers must not freeze the page.
			if (
				layer.checkVisibility &&
				!layer.checkVisibility({
					opacityProperty: true,
					visibilityProperty: true,
				})
			)
				continue;
			return true;
		}
	}
	return false;
}

/** Views alive per tab path; a view closes once no tab shows its site. */
const liveViews = new Map<string, string>();
let watchingTabs = false;

export function trackBrowseView(label: string, path: string): void {
	liveViews.set(label, path);
	if (watchingTabs) return;
	watchingTabs = true;
	workspaceStore.subscribe(({ tabs }) => {
		for (const [view, tabPath] of liveViews) {
			if (tabs.some((tab) => tab.path === tabPath)) continue;
			liveViews.delete(view);
			void commands.browseClose({ label: view });
		}
	});
}

const str = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;
const strList = (value: unknown) =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

/** One layer of a view's page; the page builds this JSON, so callers check every field. */
async function readPage(
	label: string,
	query: PageQuery,
): Promise<Record<string, unknown>> {
	const raw = JSON.parse(
		await callApiResult(() => commands.browseRead({ label, query })),
	) as unknown;
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/**
 * What a Browse view shows, for the page conversation: paper metadata first
 * (it must survive the snapshot budget), then the start of the main text.
 * Agents read further with the `browse_page` tool.
 */
export async function browsePageSnapshot(
	label: string,
	page: string,
): Promise<PageSnapshot> {
	const [summary, body, listed] = await Promise.all([
		readPage(label, { part: "summary" }),
		readPage(label, { part: "text", limit: 6000 }),
		readPage(label, { part: "targets" }),
	]);
	const paper = (summary.paper ?? {}) as Record<string, unknown>;
	const meta = [
		["Paper", str(paper.title)],
		["Authors", strList(paper.authors).join("; ") || undefined],
		["Venue", str(paper.venue)],
		["Date", str(paper.date)],
		["DOI", str(paper.doi)],
		["arXiv", str(paper.arxiv)],
		["PDF", str(paper.pdf)],
		["Browse view", label],
	]
		.filter(([, value]) => value)
		.map(([key, value]) => `${key}: ${value}`);
	return {
		page,
		title: str(summary.title),
		url: str(summary.url),
		selection: str(summary.selection),
		// Rows a site adapter lists (Cool Papers, ModelScope …).
		items: (Array.isArray(listed.items) ? listed.items : [])
			.filter((item): item is Record<string, unknown> => !!item)
			.flatMap((item) => {
				const title = str(item.title);
				return title
					? [
							{
								title,
								id: str(item.doi) ?? str(item.url),
								authors: str(item.authors),
								summary: str(item.summary),
							},
						]
					: [];
			}),
		text: [meta.join("\n"), str(body.text)].filter(Boolean).join("\n\n"),
	};
}

/** DOI, then arXiv id, then URL (as the Host picks). */
function targetIdentifier(target: BrowseImportTarget): string | undefined {
	return (target.doi ?? target.arxiv ?? target.url)?.trim() || undefined;
}

const importsInFlight = new Set<string>();

/**
 * Add a paper from a view: the one the page shows (toolbar), or `target`
 * sent by an adapter's import button. The PDF comes with the view's sign-in.
 */
export async function importFromBrowse(
	label: string,
	target?: BrowseImportTarget,
): Promise<void> {
	const t = i18n.getFixedT(null, "sidebar");
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		notifyError(t("plaza.paperPool.needsVault"));
		return;
	}
	// papers.cool rows outside arXiv import from their papers.cool page,
	// whose citation_* metadata the Translator route cannot match.
	const coolPapers =
		target && !target.doi && !target.arxiv
			? /^https:\/\/papers\.cool\/([^/]+)\/([^/?#]+)/.exec(target.url ?? "")
			: null;
	if (coolPapers) {
		await importPlazaPaper({
			id: decodeURIComponent(coolPapers[2]),
			branch: coolPapers[1],
			url: target?.url ?? "",
			title: target?.title ?? null,
		});
		return;
	}
	const identifier = target ? targetIdentifier(target) : undefined;
	const key = `${label}:${identifier ?? "page"}`;
	if (importsInFlight.has(key)) return;
	importsInFlight.add(key);
	try {
		const result = await callApiResult(() =>
			commands.browseImport({
				label,
				vaultPath,
				parentDir: currentLookupParentDir(),
				identifier: identifier ?? null,
				pdfUrl: target?.pdfUrl ?? null,
			}),
		);
		const title = result.title ?? target?.title ?? result.identifier;
		if (result.deduped) {
			notifySuccess(t("plaza.paperPool.alreadyImported", { title }));
		} else if (result.pdf) {
			notifySuccess(t("plaza.paperPool.promoted", { title }));
		} else {
			notifyWarning(t("plaza.browse.importedNoPdf", { title }), {
				description: result.messages.join("\n"),
			});
		}
	} catch (error) {
		notifyError(t("papersLibrary.importFailed"), {
			description: errorText(error),
		});
	} finally {
		importsInFlight.delete(key);
	}
}

/** Toast each agent change to a site adapter, with Undo (the previous version). */
export function watchBrowseAdapters(): () => void {
	const t = i18n.getFixedT(null, "sidebar");
	const off = events.browseAdapter.listen(({ payload }) => {
		notifyAction(t("plaza.browse.adapterChanged", { name: payload.name }), {
			description: payload.note,
			actionLabel: t("plaza.skills.undo"),
			onAction: () => {
				void callApiResult(() =>
					commands.browseAdapterRevert({
						id: payload.id,
						version: Math.max(0, payload.version - 1),
					}),
				).catch((error) => notifyError(errorText(error)));
			},
		});
	});
	return () => {
		void off.then((unlisten) => unlisten());
	};
}

/** Strings for the toolbar and card the bridge draws in the page. */
export function browseUiLabels(): BrowseUiLabels {
	const t = i18n.getFixedT(null, "viewer");
	return {
		translate: t("selection.translate"),
		ask: t("selection.askAgent"),
		copy: t("selection.copy"),
		translating: t("selection.translating"),
		shortcut: formatModShortcut("l"),
	};
}

function overlay(label: string, message: Record<string, unknown>): void {
	void commands.browseOverlay({ label, message: JSON.stringify(message) });
}

/** One running translation per view, streamed into its in-page card. */
const translations = new Map<string, SelectionTranslation>();

/** Stop a view's translation (new page, closed tab). */
export function stopBrowseTranslation(label: string): void {
	translations.get(label)?.cancel();
	translations.delete(label);
}

/**
 * Selected text from a view's toolbar: quote it into the Agent, or translate
 * it into the page's card (updates throttled to keep page evals cheap).
 */
export function handleBrowseSelection(
	label: string,
	selection: BrowseSelection,
): void {
	// Staged like a PDF selection: ⌘L / ⌘K (app shortcuts) pin it.
	if (selection.action === "stage") {
		if (selection.text) {
			publishSelection({
				text: selection.text,
				sourcePath: selection.url,
				origin: "markdown",
			});
		} else {
			clearActiveSelection("markdown");
		}
		return;
	}
	if (selection.action === "ask") {
		overlay(label, { type: "clear" });
		publishSelection({
			text: selection.text,
			sourcePath: selection.url,
			origin: "markdown",
		});
		pinActiveSelection();
		openRightTab("agent");
		focusAgentComposer();
		return;
	}
	stopBrowseTranslation(label);
	let latest = "";
	let timer: ReturnType<typeof setTimeout> | null = null;
	const flush = () => {
		timer = null;
		overlay(label, { type: "card", text: latest });
	};
	translations.set(
		label,
		translateWebSelection({
			text: selection.text,
			sourceKey: selection.url,
			onText: (text) => {
				latest = text;
				timer ??= setTimeout(flush, 120);
			},
			onError: (error) => overlay(label, { type: "card", error }),
			onSettled: () => {
				if (timer) clearTimeout(timer);
				if (latest) flush();
				translations.delete(label);
			},
		}),
	);
}
