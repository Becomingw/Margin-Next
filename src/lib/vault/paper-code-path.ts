/** Flat paper-owned source snapshots are browse-only throughout the app. */
export function isPaperCodePath(path: string): boolean {
	return /(?:^|\/)papers\/[^/]+\/code(?:\/|$)/.test(path.replace(/\\/g, "/"));
}

/** Whole snapshots can be recycled; their constituent files stay immutable. */
export function isInsidePaperCodeSnapshot(path: string): boolean {
	return /(?:^|\/)papers\/[^/]+\/code\/[^/]+\/.+/.test(
		path.replace(/\\/g, "/"),
	);
}
