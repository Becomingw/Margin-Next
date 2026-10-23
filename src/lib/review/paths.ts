/**
 * Path helpers for the review workspace (`reviews/<id>/`).
 *
 * A review unit is a peer of `papers/<id>/`, holding `manuscript.md`, an
 * optional source PDF (`<id>.pdf`), and `review.json`.
 */

import { normalizePath } from "@/lib/core/path";

export const REVIEWS_ROOT_REL = "reviews";
export const MANUSCRIPT_FILE = "manuscript.md";

/** True when `path` is the `reviews` root directory itself (Vault-relative or absolute). */
export function isReviewsRoot(path: string | null | undefined): boolean {
	if (!path) return false;
	const norm = normalizePath(path);
	return /(^|\/)reviews$/i.test(norm);
}

/** True when `path` is somewhere under a `reviews` root (not the root itself). */
export function isUnderReviews(path: string | null | undefined): boolean {
	if (!path || isReviewsRoot(path)) return false;
	const norm = normalizePath(path);
	return /(^|\/)reviews\//i.test(norm);
}

/**
 * Review unit id for any path under `reviews/<id>/` (the unit dir itself,
 * `manuscript.md`, an attached PDF, or an asset).
 */
export function reviewIdForPath(
	vaultPath: string | null,
	absPath: string,
): string | null {
	if (!absPath) return null;
	const norm = normalizePath(absPath);
	if (vaultPath) {
		const root = `${normalizePath(vaultPath)}/${REVIEWS_ROOT_REL}/`;
		if (norm.toLowerCase().startsWith(root.toLowerCase())) {
			const rest = norm.slice(root.length);
			const [id] = rest.split("/");
			if (!id || id.includes(".")) return null;
			return id;
		}
	}
	const relMatch = /^(?:.*\/)?reviews\/([^/]+)(?:\/|$)/i.exec(norm);
	if (relMatch?.[1] && !relMatch[1].includes(".")) {
		return relMatch[1];
	}
	return null;
}

/** Vault-relative `reviews/<id>/` prefix for watcher filtering. */
export function reviewUnitRelPrefix(id: string): string {
	return `${REVIEWS_ROOT_REL}/${id}/`;
}

/** True for any absolute path inside `reviews/<id>/`. */
export function isUnderReviewUnit(
	vaultPath: string | null,
	absPath: string,
): boolean {
	return reviewIdForPath(vaultPath, absPath) !== null;
}

/** True when `absPath` is a direct child directory `reviews/<id>`. */
export function isReviewUnitDir(absPath: string | null | undefined): boolean {
	if (!absPath) return false;
	const parts = normalizePath(absPath).split("/").filter(Boolean);
	return (
		parts.length >= 2 &&
		parts[parts.length - 2].toLowerCase() === REVIEWS_ROOT_REL &&
		!parts[parts.length - 1].includes(".")
	);
}

/** Case-insensitive path comparison with separator tolerance. */
export function pathsEqual(a: string, b: string): boolean {
	return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/** True when `absPath` is the vault's `reviews/` root dir. */
export function isReviewsRootDir(
	vaultPath: string | null,
	absPath: string,
): boolean {
	if (!vaultPath) return isReviewsRoot(absPath);
	const root = `${normalizePath(vaultPath)}/${REVIEWS_ROOT_REL}`;
	return pathsEqual(root, absPath);
}

/**
 * Top-level built-in vault root folders (`papers`, `reviews`, `notes`) are
 * structural roots and must never be deleted, renamed, cut, or moved.
 */
export function isProtectedVaultRoot(
	vaultPath: string | null,
	targetPath: string | null | undefined,
): boolean {
	if (!targetPath) return false;
	const normTarget = normalizePath(targetPath).toLowerCase();
	if (
		normTarget === "papers" ||
		normTarget === "reviews" ||
		normTarget === "notes"
	) {
		return true;
	}
	if (!vaultPath) return false;
	const normRoot = normalizePath(vaultPath).toLowerCase();
	return (
		normTarget === `${normRoot}/papers` ||
		normTarget === `${normRoot}/reviews` ||
		normTarget === `${normRoot}/notes`
	);
}
