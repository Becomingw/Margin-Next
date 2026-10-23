/**
 * Refresh the library (debounced, quiet) when JobCenter jobs that mutate the
 * catalog or assets settle. The file watcher already refreshes the tree for
 * on-disk changes; catalog edits (e.g. `body_source` after a download or
 * `PAPER.md` parse) are watcher-ignored, so the library needs this nudge.
 *
 * Stays on raw `job:changed` rather than the `job:completed` / `job:failed`
 * lifecycle events because `cancelled` and `skipped` also count as settled
 * here, and those have no lifecycle event.
 */

import i18n from "@/i18n";
import { events } from "@/lib/core/bindings";
import { notifyWarning } from "@/lib/core/notify";
import { isTerminalJobState, type JobKind } from "@/lib/core/tasks";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { scheduleLibraryRefresh } from "@/lib/paper/library-store";

const REFRESH_ON_KINDS: ReadonlySet<JobKind> = new Set([
	"downloadAssets",
	"parseBody",
	// Recognition upserts metadata (and may rename/merge folders) — the
	// library rows need the refetch when the job settles.
	"recognizeMetadata",
]);

/** Caller owns the returned disposer. */
export function startJobCompletionRefresh(): () => void {
	const stopJobs = listenEventSafe(events.jobChanged, ({ job }) => {
		if (!REFRESH_ON_KINDS.has(job.kind)) return;
		if (!isTerminalJobState(job.state)) return;
		if (job.kind === "recognizeMetadata" && job.state === "succeeded") {
			const params =
				job.params && typeof job.params === "object"
					? (job.params as {
							warning?: unknown;
							arxivId?: unknown;
							doi?: unknown;
						})
					: null;
			if (
				params?.warning === "arxiv_rate_limited" ||
				params?.warning === "metadata_incomplete"
			) {
				const id =
					(typeof params.arxivId === "string" && params.arxivId.trim()) ||
					(typeof params.doi === "string" && params.doi.trim()) ||
					job.paperPath?.split(/[\\/]/).pop() ||
					"";
				notifyWarning(
					i18n.t(
						params.warning === "arxiv_rate_limited"
							? "sidebar:papersLibrary.recognizeArxivRateLimited"
							: "sidebar:papersLibrary.recognizeMetadataIncomplete",
						{ id },
					),
				);
			}
		}
		scheduleLibraryRefresh();
	});
	// Native tools / the bundled CLI can mutate catalog data without a renderer
	// job. Refresh once the turn settles, including partial writes before failure.
	const stopCompleted = listenEventSafe(events.agentCompleted, () =>
		scheduleLibraryRefresh(),
	);
	const stopFailed = listenEventSafe(events.agentFailed, () =>
		scheduleLibraryRefresh(),
	);
	return () => {
		stopJobs();
		stopCompleted();
		stopFailed();
	};
}
