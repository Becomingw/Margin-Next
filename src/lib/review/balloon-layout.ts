/**
 * Where the comment column places its cards. Cards follow their text; when
 * they would overlap, the focused card (the one being written, or the
 * selected one) stays level with its text, cards above it move up and cards
 * below it move down. Without a focus, cards only move down, as before.
 */

export type BalloonSlot = { id: string; anchorY: number };

const TOP = 8;
const GAP = 10;

/** Card tops for `items` (sorted by `anchorY`), given measured heights. */
export function layoutBalloons(
	items: readonly BalloonSlot[],
	heights: Readonly<Record<string, number>>,
	focusId: string | null,
	offset = 0,
	fallbackHeight = 72,
): number[] {
	const height = (i: number) => heights[items[i].id] ?? fallbackHeight;
	const anchor = (i: number) => items[i].anchorY + offset;
	const focus = focusId ? items.findIndex((item) => item.id === focusId) : -1;
	const wanted = items.map((_, i) => anchor(i));
	if (focus >= 0) {
		wanted[focus] = Math.max(TOP, anchor(focus));
		for (let i = focus - 1; i >= 0; i--) {
			wanted[i] = Math.min(anchor(i), wanted[i + 1] - GAP - height(i));
		}
	}
	// Downward pass: nothing overlaps, and nothing rises above the column.
	const tops: number[] = [];
	let cursor = TOP;
	for (let i = 0; i < items.length; i++) {
		tops[i] = Math.max(wanted[i], cursor);
		cursor = tops[i] + height(i) + GAP;
	}
	return tops;
}
