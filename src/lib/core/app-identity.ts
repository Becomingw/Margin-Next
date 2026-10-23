/**
 * Product identity as it appears on disk, in Web Storage and in app-written
 * records. Mirrors the Host `edda_core::paths` constants; spell the name
 * through these instead of string literals.
 */

/** Lowercase product slug (Host `APP_SLUG`): storage-key prefix, provenance tags. */
export const APP_SLUG = "edda";

/** Hidden product directory (Host `APP_DOT_DIR`): `{vault}/.edda`, `~/.edda`. */
export const APP_DOT_DIR = `.${APP_SLUG}`;

/** Infix of Host atomic-write temps (Host `RENAME_TEMP_MARKER`). */
export const RENAME_TEMP_MARKER = `${APP_DOT_DIR}-rename-`;

/** Scheme of in-app pseudo paths (`edda:library`); never a filesystem path. */
export const VIRTUAL_PATH_PREFIX = `${APP_SLUG}:`;

/** Slug of the build being migrated from (Host `app_rename::FORMER_APP_SLUG`). */
export const FORMER_APP_SLUG = "agentero";

/** Every name the vault-private directory has had (Host `KNOWN_APP_DOT_DIRS`). */
export const KNOWN_APP_DOT_DIRS = [".agentero", ".edda"] as const;

/** Whether this build runs under a new slug and adopts former state. */
export const isRenamed = (APP_SLUG as string) !== FORMER_APP_SLUG;
