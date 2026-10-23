import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, type SlateEditor } from "platejs";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { joinFrontmatter, splitFrontmatter } from "@/lib/markdown/frontmatter";
import {
	computeTrackedChanges,
	rejectTrackedChange,
	type TrackedChange,
} from "@/lib/review/anchor";

/** Build a proposal in an isolated tree, never falling back to the whole doc. */
export function revisionCandidate(
	live: SlateEditor,
	baseline: string,
	current: string,
	change: TrackedChange,
	action: "accept" | "reject",
): string | null {
	const editor = createSlateEditor({ plugins: MarkdownKit });
	const source = splitFrontmatter(action === "accept" ? baseline : current);
	if (action === "reject") {
		editor.children = structuredClone(live.children);
		if (!rejectTrackedChange(editor, baseline, change)) return null;
	} else {
		editor.children = editor
			.getApi(MarkdownPlugin)
			.markdown.deserialize(prepareMarkdownForDeserialize(source.body || " "));
		const preceding = computeTrackedChanges(live, baseline).changes.filter(
			(c) =>
				c.currentBlockIndex === change.currentBlockIndex &&
				c.charOffset < change.charOffset &&
				!c.blockDeletion,
		);
		const originalOffset =
			change.charOffset -
			preceding.reduce((sum, c) => sum + c.after.length - c.before.length, 0);
		// Accepting the live comparison rejects its inverse in the baseline tree.
		const inverse = computeTrackedChanges(editor, current).changes.filter(
			(candidate) =>
				candidate.before === change.after &&
				candidate.after === change.before &&
				(!change.baselineBlock ||
					change.blockDeletion ||
					candidate.charOffset === originalOffset) &&
				(candidate.currentBlockIndex === change.baselineBlockIndex ||
					(!change.baselineBlock &&
						candidate.baselineBlockIndex === change.currentBlockIndex)),
		);
		if (
			inverse.length !== 1 ||
			!rejectTrackedChange(editor, current, inverse[0])
		)
			return null;
	}
	return joinFrontmatter(
		source.frontmatter,
		editor.getApi(MarkdownPlugin).markdown.serialize(),
	);
}
