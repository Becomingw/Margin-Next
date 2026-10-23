/**
 * 广场（Plaza）— external discovery sources.
 *
 * Virtual tree/tab paths only; nothing here ever touches disk. Adding a source
 * is a single {@link PLAZA_SOURCES} entry — the sidebar child row and the
 * center panel both derive from this registry.
 *
 * @see docs/development/plaza.md
 */

import i18n from "@/i18n";
import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
import type { BrowseSite } from "@/lib/core/bindings";
import { getSettings } from "@/lib/settings/react-store";

/** Virtual tree/tab path for the Plaza parent node. */
export const PLAZA_VIRTUAL_PATH = `${VIRTUAL_PATH_PREFIX}plaza`;

/**
 * Icon key for a plaza source. Lib only carries the name; the
 * name→component map lives in the components layer
 * (`components/plaza/source-icons.ts`).
 */
export type PlazaSourceIcon =
	| "coolPapers"
	| "modelScope"
	| "sparkles"
	| "paperPool"
	| "globe";

export type PlazaSource = {
	id: string;
	/** `edda:plaza/<id>` — virtual, never a filesystem path. */
	path: string;
	label: string;
	/** Site home for `browse` panels; `null` for app panels. */
	url: string | null;
	/**
	 * Panel kind. `browse`: a website in a native webview (built-in sites and
	 * user-added ones, see `components/plaza/browse-view.tsx`).
	 */
	panel: "skills" | "paperPool" | "browse";
	/** Icon name; rendered through the components-layer icon map. */
	icon: PlazaSourceIcon;
};

function sourcePath(id: string): string {
	return `${PLAZA_VIRTUAL_PATH}/${id}`;
}

export const PLAZA_SOURCES: readonly PlazaSource[] = [
	{
		id: "cool-papers",
		path: sourcePath("cool-papers"),
		label: "Cool Papers",
		url: "https://papers.cool/",
		panel: "browse",
		icon: "coolPapers",
	},
	{
		id: "modelscope",
		path: sourcePath("modelscope"),
		label: "ModelScope Papers",
		url: "https://modelscope.cn/papers",
		panel: "browse",
		icon: "modelScope",
	},
	{
		id: "skills",
		path: sourcePath("skills"),
		label: "Skill management",
		url: null,
		panel: "skills",
		icon: "sparkles",
	},
	{
		id: "paper-pool",
		path: sourcePath("paper-pool"),
		label: "Paper pool",
		url: null,
		panel: "paperPool",
		icon: "paperPool",
	},
];

export function normalizePlazaPath(path: string): string {
	// Retired sources reopen as the paper pool.
	return path === sourcePath("feeds") ||
		path === sourcePath("arxiv-rec") ||
		path === sourcePath("paper-map")
		? sourcePath("paper-pool")
		: path;
}

/** True for the Plaza parent node and every source under this parent. */
export function isPlazaVirtualPath(path: string | null | undefined): boolean {
	if (!path) return false;
	return (
		path === PLAZA_VIRTUAL_PATH || path.startsWith(`${PLAZA_VIRTUAL_PATH}/`)
	);
}

export function isPlazaRootPath(path: string | null | undefined): boolean {
	return path === PLAZA_VIRTUAL_PATH;
}

const BROWSE_SITE_PREFIX = `${PLAZA_VIRTUAL_PATH}/site/`;

/** Tab path of a user-added website. */
export function browseSitePath(siteId: string): string {
	return `${BROWSE_SITE_PREFIX}${siteId}`;
}

/** A user-added website as a source (native webview panel). */
export function browseSiteSource(site: BrowseSite): PlazaSource {
	return {
		id: `site:${site.id}`,
		path: browseSitePath(site.id),
		label: site.name,
		url: site.url,
		panel: "browse",
		icon: "globe",
	};
}

/** The user-added website behind a Browse tab path, if any. */
export function browseSiteForPath(
	path: string | null | undefined,
): BrowseSite | null {
	if (!path?.startsWith(BROWSE_SITE_PREFIX)) return null;
	const id = path.slice(BROWSE_SITE_PREFIX.length);
	return getSettings().browseSites.find((site) => site.id === id) ?? null;
}

/**
 * The website a `browse` panel shows: a user-added site, or a built-in one
 * (Cool Papers, ModelScope) whose page scripts come from preset adapters.
 */
export function browsePanelSite(source: PlazaSource): BrowseSite | null {
	if (source.panel !== "browse" || !source.url) return null;
	return (
		browseSiteForPath(source.path) ?? {
			id: source.id,
			name: plazaSourceLabel(source),
			url: source.url,
		}
	);
}

/** The source owning this path, or `null` for the Plaza root / non-Plaza paths. */
export function plazaSourceForPath(
	path: string | null | undefined,
): PlazaSource | null {
	if (!path) return null;
	const builtin = PLAZA_SOURCES.find((source) => source.path === path);
	if (builtin) return builtin;
	const site = browseSiteForPath(path);
	return site ? browseSiteSource(site) : null;
}

/**
 * Children of 浏览 (Browse): built-in sites not hidden by the user
 * (`plazaHiddenSources`), then the user's own websites. Skill management and
 * the paper pool live elsewhere in the tree.
 */
export function visiblePlazaSources(
	hiddenIds: readonly string[],
	sites: readonly BrowseSite[] = [],
): PlazaSource[] {
	const hidden = new Set(hiddenIds);
	return [
		...PLAZA_SOURCES.filter(
			(source) =>
				source.panel !== "skills" &&
				source.panel !== "paperPool" &&
				!hidden.has(source.id),
		),
		...sites.map(browseSiteSource),
	];
}

/** The paper pool, shown under 论文库 (Library) rather than under Browse. */
export const PAPER_POOL_SOURCE = PLAZA_SOURCES.find(
	(source) => source.panel === "paperPool",
) as PlazaSource;

/** Management stays reachable even when discovery sources are hidden. */
export const SKILL_MANAGEMENT_SOURCE = PLAZA_SOURCES.find(
	(source) => source.panel === "skills",
) as PlazaSource;

/** Tab title for any Plaza path. */
export function plazaSourceLabel(source: PlazaSource): string {
	switch (source.id) {
		case "skills":
			return i18n.t("sidebar:plaza.skills.title");
		case "modelscope":
			return i18n.t("sidebar:plaza.modelscope");
		case "paper-pool":
			return i18n.t("sidebar:plaza.paperPool.title");
		default:
			return source.label;
	}
}

export function plazaTitleForPath(path: string): string {
	const source = plazaSourceForPath(path);
	return source ? plazaSourceLabel(source) : i18n.t("sidebar:plaza.plaza");
}
