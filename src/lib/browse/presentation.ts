import type { BrowseRect } from "@/lib/core/bindings";

type Target = { rect: BrowseRect; visible: boolean; covered: boolean };
type Dependencies = {
	capture?: () => Promise<string>;
	/** Resolves after the decoded frame is painted behind the native view. */
	showFrame: (source: string) => Promise<void>;
	clearFrame: () => void;
	setBounds: (rect: BrowseRect, visible: boolean) => Promise<unknown>;
	onError: (error: unknown) => void;
};

/** Serial, latest-target-wins handoff. A late capture must never hide a tab
 * after its menu closed, resurrect an unmounted view, or overwrite a new frame. */
export function createBrowsePresentation(deps: Dependencies) {
	let target: Target | undefined;
	let revision = 0;
	let visibilityRevision = 0;
	let running = false;
	let capturing = false;
	let disposed = false;
	let frame = false;
	let captureFailed = false;
	let sent = "";
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;

	const clear = () => {
		deps.clearFrame();
		frame = false;
	};
	const flush = async () => {
		if (running || disposed) return;
		clearTimeout(retry);
		running = true;
		try {
			while (target && !disposed) {
				const next = target;
				const current = revision;
				const visibility = visibilityRevision;
				if (
					next.visible &&
					next.covered &&
					!frame &&
					!captureFailed &&
					deps.capture
				) {
					capturing = true;
					try {
						const source = await deps.capture();
						if (disposed || visibility !== visibilityRevision) continue;
						await deps.showFrame(source);
						if (disposed || visibility !== visibilityRevision) {
							clear();
							continue;
						}
						frame = true;
						// Resizing during a capture changes the destination, not the
						// handoff: reuse this frame instead of starving drag-and-drop.
						if (current !== revision) continue;
					} catch (error) {
						if (disposed || visibility !== visibilityRevision) continue;
						clear();
						captureFailed = true;
						deps.onError(error);
					} finally {
						capturing = false;
					}
				}
				if (disposed) break;
				const visible = next.visible && !next.covered;
				const key = JSON.stringify([next.rect, visible]);
				if (key !== sent) {
					await deps.setBounds(next.rect, visible);
					sent = key;
				}
				if (disposed) break;
				if (!next.covered || !next.visible) {
					// Show the live native surface before dropping its handoff frame.
					clear();
					captureFailed = false;
				}
				if (current === revision) break;
			}
			failures = 0;
		} catch (error) {
			if (!disposed) {
				if (failures++ === 0) deps.onError(error);
				// A transient IPC failure must not leave the page hidden forever.
				if (failures < 3) retry = setTimeout(() => void flush(), 250);
			}
		} finally {
			running = false;
		}
	};
	return {
		update(next: Target) {
			if (disposed) return;
			if (capturing && !next.visible && target?.visible) {
				// An inactive tab must disappear immediately, even if native
				// capture is slow. Invalidate the cached bounds for its next show.
				sent = "";
				void deps.setBounds(next.rect, false).catch((error) => {
					if (!disposed) deps.onError(error);
				});
			}
			if (target?.visible !== next.visible || target?.covered !== next.covered)
				visibilityRevision++;
			target = next;
			revision++;
			void flush();
		},
		dispose(rect: BrowseRect) {
			disposed = true;
			clearTimeout(retry);
			revision++;
			clear();
			// The Host lifecycle gate puts this after any in-flight creation/show.
			void deps.setBounds(rect, false).catch(() => {});
		},
	};
}
