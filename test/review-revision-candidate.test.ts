import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, NodeApi } from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { revisionCandidate } from "@/components/review/revision-candidate";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { computeTrackedChanges } from "@/lib/review/anchor";

function setup(current: string) {
	const editor = createSlateEditor({ plugins: MarkdownKit });
	editor.children = editor
		.getApi(MarkdownPlugin)
		.markdown.deserialize(splitFrontmatter(current).body);
	return editor;
}
describe("transactional revision candidates", () => {
	it("accepts only the selected repeated word in a paragraph", () => {
		const baseline = "left old and right old.\n";
		const current = "left revised and right revised.\n";
		const editor = setup(current);
		const changes = computeTrackedChanges(editor, baseline).changes;
		expect(changes).toHaveLength(2);
		const original = NodeApi.string(editor);
		expect(
			revisionCandidate(editor, baseline, current, changes[1], "accept"),
		).toBe("left old and right revised.\n");
		expect(NodeApi.string(editor)).toBe(original);
	});
	it("rejects one added paragraph without reverting its neighbors", () => {
		const baseline = "First paragraph.\n\nLast paragraph.\n";
		const current =
			"First paragraph.\n\nAdded paragraph.\n\nLast paragraph.\n\nAnother addition.\n";
		const editor = setup(current);
		const changes = computeTrackedChanges(editor, baseline).changes;
		expect(changes).toHaveLength(2);
		expect(
			revisionCandidate(editor, baseline, current, changes[0], "reject"),
		).toBe("First paragraph.\n\nLast paragraph.\n\nAnother addition.\n");
		expect(
			revisionCandidate(editor, baseline, current, changes[0], "accept"),
		).toBe("First paragraph.\n\nAdded paragraph.\n\nLast paragraph.\n");
	});
	it("restores one removed paragraph while preserving frontmatter and other changes", () => {
		const fm = "---\ntitle: Test\n---\n\n";
		const baseline = `${fm}First paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n`;
		const current = `${fm}First paragraph.\n\nLast paragraph.\n\nAddition.\n`;
		const editor = setup(current);
		const change = computeTrackedChanges(editor, baseline).changes.find(
			(c) => c.blockDeletion,
		);
		expect(change).toBeDefined();
		if (!change) throw new Error("missing deletion fixture");
		const result = revisionCandidate(
			editor,
			baseline,
			current,
			change,
			"reject",
		);
		expect(result).toContain("title: Test");
		expect(result).toContain("Middle paragraph.");
		expect(result).toContain("Addition.");
	});
});
