import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor, NodeApi } from "platejs";
import { describe, expect, it } from "vitest";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { applyValueDiff } from "@/lib/markdown/apply-value-diff";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

function editorWith(markdown: string) {
	const editor = createSlateEditor({ plugins: MarkdownEditorKit as never });
	// As in the app, where the open document has always been normalized.
	editor.tf.setValue(parse(editor, markdown));
	return editor;
}

function parse(editor: ReturnType<typeof createSlateEditor>, markdown: string) {
	return editor
		.getApi(MarkdownPlugin)
		.markdown.deserialize(prepareMarkdownForDeserialize(markdown || " "));
}

const serialize = (editor: ReturnType<typeof createSlateEditor>) =>
	editor.getApi(MarkdownPlugin).markdown.serialize();

/** Edits an Agent or another app might make to a document. */
function variants(markdown: string): string[] {
	const blocks = markdown.split("\n\n");
	const mid = Math.floor(blocks.length / 2);
	const edit = (fn: (b: string[]) => void) => {
		const copy = [...blocks];
		fn(copy);
		return copy.join("\n\n");
	};
	return [
		edit((b) => {
			b[mid] = `${b[mid]} (revised wording)`;
		}),
		edit((b) => {
			b.splice(mid, 1);
		}),
		edit((b) => {
			b.splice(mid, 0, "A new paragraph an Agent inserted.");
		}),
		edit((b) => {
			b[0] = b[0].startsWith("# ") ? `## ${b[0].slice(2)}` : `# ${b[0]}`;
		}),
		edit((b) => {
			b[1] = `${b[1]} **bold addition**`;
			b.splice(b.length - 1, 1);
			b.splice(mid, 0, "- list item one\n- list item two");
		}),
	];
}

function markdownFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return markdownFiles(path);
		return name.endsWith(".md") ? [path] : [];
	});
}

describe("applying an external write as minimal changes", () => {
	it("ends with the same document as replacing the whole value", {
		timeout: 120_000,
	}, () => {
		const failures: string[] = [];
		// Normalizing a whole document (as the old reload did) is slow; 40
		// shorter docs cover the block types (tables, code, lists, HTML, math).
		const files = markdownFiles("docs")
			.map((file) => splitFrontmatter(readFileSync(file, "utf8")).body)
			.filter((body) => body.length <= 8_000)
			.slice(0, 40);
		for (const [f, body] of files.entries()) {
			const original = editorWith(body).children;
			for (const [v, next] of variants(body).entries()) {
				const editor = createSlateEditor({
					plugins: MarkdownEditorKit as never,
				});
				editor.children = structuredClone(original);
				applyValueDiff(editor, parse(editor, next));
				// What a reload did before: replace every node.
				if (serialize(editor) !== serialize(editorWith(next))) {
					failures.push(`${f}#${v}`);
				}
				// As opened in the app (Plate does not normalize the first value):
				// after one write, the same text again changes nothing, although
				// the inserted blocks were normalized. Unless normalization lost
				// text (a link the parser put straight into a table cell), which
				// then differs on every write, as with the whole-value reload.
				const opened = createSlateEditor({
					plugins: MarkdownEditorKit as never,
				});
				opened.children = parse(opened, body);
				applyValueDiff(opened, parse(opened, next));
				const parsed = parse(opened, next);
				const lost =
					NodeApi.string(opened) !==
					NodeApi.string({ children: parsed } as never);
				if (!lost && applyValueDiff(opened, parsed) !== 0) {
					failures.push(`${f}#${v} again`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("replaces only the changed block and keeps ranges elsewhere", () => {
		const editor = editorWith(
			"# Title\n\nThe model cuts memory by 40% everywhere.\n\nUnchanged ending.\n",
		);
		const [title, , ending] = editor.children;
		const range = (path: number[], from: number, to: number) =>
			editor.api.rangeRef({
				anchor: { path, offset: from },
				focus: { path, offset: to },
			});
		const inRewrite = range([1, 0], 4, 9);
		const inEnding = range([2, 0], 0, 9);
		const touched = applyValueDiff(
			editor,
			parse(
				editor,
				"New intro.\n\n# Title\n\nThe model cuts peak memory by 38% everywhere.\n\nUnchanged ending.\n",
			),
		);
		expect(touched).toBe(2);
		expect(editor.children[1]).toBe(title);
		expect(editor.children[3]).toBe(ending);
		// A comment in the rewritten paragraph is placed again from its quote;
		// one in an untouched block keeps its range.
		expect(inRewrite.current).toBeNull();
		expect(inEnding.current && editor.api.string(inEnding.current)).toBe(
			"Unchanged",
		);
		expect(serialize(editor)).toContain("cuts peak memory by 38%");
	});
});
