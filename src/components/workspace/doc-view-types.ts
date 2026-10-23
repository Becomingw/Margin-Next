import type { WikiRenameHeadingRequest } from "@/lib/wiki";
import type { PersistWriter } from "@/lib/workspace/actions";
import type { DocTab } from "@/lib/workspace/tabs";

/** Markdown / NOTES editor props. */
export type DocViewEditorProps = {
	fontSize: number;
	/** CSS font-family stack; omit/undefined keeps app theme font. */
	fontFamily?: string;
	/** Unitless line-height for body text. */
	lineHeight?: number;
	showToolbar: boolean;
	notesPlaceholder: string;
	markdownPlaceholder: string;
	onPersistFile: (
		path: string,
		md: string,
		lastSaved: string,
		write?: PersistWriter,
	) => Promise<boolean>;
	onAssetsChanged: () => void;
	onTabPatch: (id: string, patch: Partial<DocTab>) => void;
	onRenameHeading?: (
		path: string,
		request: Omit<WikiRenameHeadingRequest, "path">,
	) => Promise<void>;
};
