/**
 * Page context for page-scoped Agent conversations (`page:<path>`).
 *
 * A page that can describe itself registers a provider under its virtual path;
 * when the user sends from that page's conversation, the provider's snapshot is
 * appended to the turn as a hidden context block. Papers are not routed here —
 * paper conversations already carry the paper and its sources.
 */

/** Marker opening the block; `prompt-display` strips from here in transcripts. */
export const PAGE_CONTEXT_MARKER =
	"Current page in Edda (snapshot taken when this message was sent):";

/** One listed entry on the page (e.g. a paper card). */
export type PageItem = {
	title: string;
	id?: string;
	authors?: string;
	summary?: string;
	/** On screen when the snapshot was taken. */
	visible?: boolean;
};

export type PageSnapshot = {
	/** Human page name, e.g. the source label. */
	page: string;
	title?: string;
	url?: string;
	selection?: string;
	items?: PageItem[];
	/** Main text when the page is not a list. */
	text?: string;
};

export type PageContextProvider = () => Promise<PageSnapshot | null>;

const providers = new Map<string, PageContextProvider>();

/** Budget for the whole block; roughly 1–2k tokens. */
const MAX_CHARS = 6000;
const MAX_SUMMARY_CHARS = 400;
const PROVIDER_TIMEOUT_MS = 1000;
const FALLBACK_FOCUS_ITEMS = 3;

/** Register the provider for a page path; returns the unregister function. */
export function registerPageContext(
	path: string,
	provider: PageContextProvider,
): () => void {
	providers.set(path, provider);
	return () => {
		if (providers.get(path) === provider) providers.delete(path);
	};
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Render a snapshot as a bounded Markdown-ish block. On-screen items come
 * first with their summaries; the rest are listed by title while budget lasts.
 */
export function formatPageSnapshot(
	snapshot: PageSnapshot,
	maxChars = MAX_CHARS,
): string {
	const head = [PAGE_CONTEXT_MARKER, `Page: ${snapshot.page}`];
	if (snapshot.title?.trim()) head.push(`Title: ${clip(snapshot.title, 200)}`);
	if (snapshot.url?.trim()) head.push(`URL: ${snapshot.url.trim()}`);
	if (snapshot.selection?.trim()) {
		head.push(`Selected text:\n> ${clip(snapshot.selection, 1500)}`);
	}
	let out = head.join("\n");
	const room = () => maxChars - out.length;

	// Detail pages send their text alongside related rows: text first, but
	// leave half the budget for the rows.
	const items = snapshot.items ?? [];
	if (snapshot.text?.trim()) {
		const budget = Math.min(
			room() - 20,
			items.length ? maxChars / 2 : maxChars,
		);
		if (budget > 200) out += `\nPage text:\n${clip(snapshot.text, budget)}`;
	}
	if (items.length) {
		// A hidden or zero-height frame reports nothing on screen: treat the top
		// rows as the focus so their summaries still come through.
		const focus = items.some((item) => item.visible)
			? items.filter((item) => item.visible)
			: items.slice(0, FALLBACK_FOCUS_ITEMS);
		const ordered = [
			...focus,
			...items.filter((item) => !focus.includes(item)),
		];
		out += `\nItems on the page (${items.length}; on-screen first):`;
		let shown = 0;
		for (const item of ordered) {
			const parts = [clip(item.title, 300)];
			if (item.id) parts.push(`[${item.id}]`);
			if (item.authors) parts.push(`— ${clip(item.authors, 160)}`);
			let line = `\n- ${parts.join(" ")}`;
			if (focus.includes(item) && item.summary) {
				line += `\n  ${clip(item.summary, MAX_SUMMARY_CHARS)}`;
			}
			if (line.length > room()) break;
			out += line;
			shown++;
		}
		if (shown < ordered.length) {
			out += `\n(${ordered.length - shown} more not listed)`;
		}
	}
	return out;
}

/**
 * Snapshot of the page at `path`, formatted for the prompt. `null` when the
 * page has no provider or does not answer in time — sending never waits long.
 */
export async function collectPageContext(path: string): Promise<string | null> {
	const provider = providers.get(path);
	if (!provider) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), PROVIDER_TIMEOUT_MS);
	});
	try {
		const snapshot = await Promise.race([
			provider().catch(() => null),
			timeout,
		]);
		return snapshot ? formatPageSnapshot(snapshot) : null;
	} finally {
		clearTimeout(timer);
	}
}
