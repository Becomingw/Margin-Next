export type { CreateVaultResult } from "@/lib/core/bindings";

export type FileNode = {
	id: string;
	name: string;
	path: string;
	kind: "file" | "directory";
	children?: FileNode[];
	/**
	 * Directory whose children have not been listed yet (lazy tree).
	 * `true` → show as folder; load on expand. Omit / `false` when loaded
	 * (including empty dirs, which use `children: []`).
	 */
	childrenPending?: boolean;
	/**
	 * Paper `source/` shells only: whether TeX exists on disk. Needed because
	 * lazy children hide `.tex` files from tree-based asset detection.
	 */
	hasTex?: boolean;
};
