/**
 * Zotero Connector attachment saves as JobCenter jobs.
 *
 * The Host writes the attachment and streams `connector:progress` per
 * `session:paper` key. This module turns that stream into one `connectorSync`
 * job per key and relays it (detail/progress → `ctx.report`, terminal status →
 * job state), so the task-panel row comes from the single JobCenter projection
 * instead of writing the legacy store directly.
 */

import i18n from "@/i18n";
import { type ConnectorProgress, events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import {
	enqueueTask,
	registerTaskExecutor,
	type TaskExecutorContext,
} from "@/lib/core/tasks";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { getVaultPath } from "@/lib/vault/store";

/**
 * One key's buffered stream: events sent while the job is still queued (or its
 * offer in flight) must survive until the executor consumes them.
 */
type Feed = {
	pending: ConnectorProgress[];
	wake: (() => void) | null;
};

const feeds = new Map<string, Feed>();
const enqueued = new Set<string>();

/** Register the renderer-side `connectorSync` executor (before `startTaskRuntime`). */
export function registerConnectorTaskExecutor(): void {
	registerTaskExecutor("connectorSync", runConnectorSyncExecutor);
}

/** Subscribe the relay. Caller owns the disposer. */
export function startConnectorProgressRelay(): () => void {
	return listenEventSafe(events.connectorProgress, (payload) => {
		if (payload?.key) onConnectorProgress(payload);
	});
}

function onConnectorProgress(event: ConnectorProgress): void {
	const feed = feedFor(event.key);
	feed.pending.push(event);
	feed.wake?.();
	feed.wake = null;
	if (enqueued.has(event.key)) return;
	enqueued.add(event.key);
	void enqueueConnectorJob(event);
}

function feedFor(key: string): Feed {
	const existing = feeds.get(key);
	if (existing) return existing;
	const feed: Feed = { pending: [], wake: null };
	feeds.set(key, feed);
	return feed;
}

function closeFeed(key: string): void {
	feeds.delete(key);
	enqueued.delete(key);
}

async function enqueueConnectorJob(event: ConnectorProgress): Promise<void> {
	const vaultPath = getVaultPath();
	if (!vaultPath) {
		closeFeed(event.key);
		return;
	}
	try {
		await enqueueTask({
			kind: "connectorSync",
			vaultPath,
			path: event.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
			lane: "normal",
			params: {
				key: event.key,
				title: event.title || null,
				detail: event.detail,
			},
		});
	} catch (error) {
		logger.warn("connector job enqueue failed", {
			key: event.key,
			error: errorText(error),
		});
		closeFeed(event.key);
	}
}

async function runConnectorSyncExecutor(
	ctx: TaskExecutorContext,
): Promise<void> {
	const key = connectorKey(ctx.params);
	const feed = key ? feeds.get(key) : undefined;
	// No buffered stream means this renderer never saw one: the job was
	// re-claimed after a reload whose events already settled. Give the slot back
	// instead of holding it until the report timeout.
	if (!key || !feed || feed.pending.length === 0) {
		if (key) closeFeed(key);
		await ctx.report({ state: "cancelled" });
		return;
	}
	for (;;) {
		if (ctx.signal.aborted) {
			// Cancelled: the projection already flipped the row.
			closeFeed(key);
			return;
		}
		const event = await nextEvent(feed, ctx.signal);
		// Woken without an event (or by the abort): re-check and keep waiting.
		if (!event) continue;
		const failed = event.status === "failed";
		const done = failed || event.status === "completed";
		// Keep the legacy completion text when the Host sends no detail, so
		// the settled row does not fall back to the first event's detail.
		const phase =
			done && !failed && !event.detail?.trim()
				? i18n.t("app:tasks.connectorComplete")
				: event.detail;
		await ctx.report({
			progress: event.progress,
			phase,
			...(done
				? {
						state: failed ? ("failed" as const) : ("succeeded" as const),
						error: failed ? failureText(event) : undefined,
					}
				: {}),
		});
		if (done) {
			closeFeed(key);
			return;
		}
	}
}

function failureText(event: ConnectorProgress): string {
	return (
		event.error?.trim() ||
		event.detail?.trim() ||
		i18n.t("app:tasks.connectorFailed")
	);
}

function nextEvent(
	feed: Feed,
	signal: AbortSignal,
): Promise<ConnectorProgress | null> {
	const buffered = feed.pending.shift();
	if (buffered) return Promise.resolve(buffered);
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve) => {
		const onAbort = () => {
			feed.wake = null;
			resolve(null);
		};
		feed.wake = () => {
			signal.removeEventListener("abort", onAbort);
			resolve(feed.pending.shift() ?? null);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function connectorKey(params: unknown): string | null {
	const key =
		params && typeof params === "object"
			? (params as { key?: unknown }).key
			: undefined;
	return typeof key === "string" && key.trim() ? key : null;
}
