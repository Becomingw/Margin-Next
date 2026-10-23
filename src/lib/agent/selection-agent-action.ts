/**
 * Surface-owned handlers for ⌘K: quote the live selection into the full Agent.
 * PDF / Plaza register while mounted; App tries handlers newest-first until one
 * consumes the chord. Each handler returns false when it has no armed selection.
 */

type SelectionAgentHandler = () => boolean;

const handlers = new Set<SelectionAgentHandler>();

/** Register a surface reference action; returns an unregister fn. */
export function registerSelectionAgentAction(
	next: SelectionAgentHandler,
): () => void {
	handlers.add(next);
	return () => {
		handlers.delete(next);
	};
}

/** Run registered reference handlers (newest first) until one succeeds. */
export function runSelectionAgentAction(): boolean {
	const stack = [...handlers].reverse();
	for (const handler of stack) {
		if (handler()) return true;
	}
	return false;
}
