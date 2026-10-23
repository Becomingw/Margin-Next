import type { PlazaSource } from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";

export type TreeCreateKind = "file" | "folder" | "review";

export type TreeCreateDraft = {
	kind: TreeCreateKind;
	/** Absolute path of the parent directory (vault root or folder). */
	parentPath: string;
};

export type TreeRenameDraft = {
	/** Absolute path of the file/folder being renamed. */
	path: string;
	/** Current disk name (basename). */
	currentName: string;
};

/** One flattened, windowable tree row in display order. */
export type FlatRow =
	| { key: string; kind: "library" }
	| { key: string; kind: "trash" }
	| { key: string; kind: "plaza" }
	| { key: string; kind: "plazaSource"; source: PlazaSource }
	/** "Add website" action row at the end of 浏览 (Browse). */
	| { key: string; kind: "plazaAdd" }
	| { key: string; kind: "create"; depth: number }
	| {
			key: string;
			kind: "node";
			depth: number;
			node: FileNode;
			paperLeaf: boolean;
			reviewLeaf?: boolean;
	  };

export type TreeContextMenu = {
	path: string;
	x: number;
	y: number;
};
