import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor } from "platejs";
import { describe, expect, it, vi } from "vitest";
import { MarkdownEditorKit } from "@/components/editor/plugins/markdown-editor-kit";
import { prepareMarkdownForDeserialize } from "@/lib/markdown/deserialize";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { createIncrementalSerializer } from "@/lib/markdown/incremental-serialize";

function markdownFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return markdownFiles(path);
		return name.endsWith(".md") ? [path] : [];
	});
}

function editorWith(markdown: string) {
	const editor = createSlateEditor({ plugins: MarkdownEditorKit as never });
	editor.children = editor
		.getApi(MarkdownPlugin)
		.markdown.deserialize(prepareMarkdownForDeserialize(markdown || " "));
	return editor;
}

describe("incremental Markdown serialization", () => {
	it("matches whole-document serialization for every document in the repo", {
		timeout: 120_000,
	}, () => {
		const files = [
			...markdownFiles("docs"),
			...markdownFiles("templates"),
			"README.md",
			"README.en.md",
			"AGENTS.md",
		];
		const mismatched = files.filter((file) => {
			const { body } = splitFrontmatter(readFileSync(file, "utf8"));
			const editor = editorWith(body);
			const whole = editor.getApi(MarkdownPlugin).markdown.serialize();
			return createIncrementalSerializer(editor).serialize() !== whole;
		});
		expect(mismatched).toEqual([]);
	});

	it("re-serializes only the segment an edit touched", () => {
		const editor = editorWith(
			"# Title\n\nFirst paragraph.\n\n- one\n- two\n\nLast paragraph.\n",
		);
		const { serialize } = createIncrementalSerializer(editor);
		const whole = () => editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(serialize()).toBe(whole());

		const spy = vi.spyOn(editor.getApi(MarkdownPlugin).markdown, "serialize");
		editor.tf.insertText(" More", { at: editor.api.end([1]) });
		const edited = serialize();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(edited).toContain("First paragraph. More");

		spy.mockClear();
		editor.tf.insertText("!", { at: editor.api.end([3]) });
		const next = serialize();
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
		expect(next).toBe(whole());
		expect(next).toContain("two!");
		expect(edited).toBe(next.replace("two!", "two"));
	});

	it("warms its cache so the first save does not serialize every block", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const editor = editorWith(
				Array.from({ length: 200 }, (_, i) => `Paragraph ${i}.`).join("\n\n"),
			);
			const serializer = createIncrementalSerializer(editor);
			serializer.warm();
			vi.runAllTimers();
			const spy = vi.spyOn(editor.getApi(MarkdownPlugin).markdown, "serialize");
			expect(serializer.serialize()).toContain("Paragraph 199.");
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});
});
