import { describe, expect, it } from "vitest";
import {
	collectPageContext,
	formatPageSnapshot,
	PAGE_CONTEXT_MARKER,
	registerPageContext,
} from "@/lib/agent/page-context";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";

describe("page context", () => {
	it("lists on-screen rows first with summaries, the rest by title", () => {
		const block = formatPageSnapshot({
			page: "Cool Papers",
			url: "https://papers.cool/arxiv/cs.CL",
			items: [
				{ title: "Below the fold", id: "2", summary: "hidden abstract" },
				{
					title: "On screen",
					id: "1",
					authors: "A. Author",
					summary: "visible abstract",
					visible: true,
				},
			],
		});
		expect(block.startsWith(PAGE_CONTEXT_MARKER)).toBe(true);
		expect(block.indexOf("On screen")).toBeLessThan(
			block.indexOf("Below the fold"),
		);
		expect(block).toContain("visible abstract");
		expect(block).not.toContain("hidden abstract");
	});

	it("falls back to the top rows when nothing is reported on screen", () => {
		const block = formatPageSnapshot({
			page: "List",
			items: ["a", "b", "c", "d"].map((id) => ({
				title: `Paper ${id}`,
				summary: `abstract ${id}`,
			})),
		});
		expect(block).toContain("abstract c");
		expect(block).not.toContain("abstract d");
	});

	it("stays within budget and says how many rows were dropped", () => {
		const items = Array.from({ length: 300 }, (_, i) => ({
			title: `Paper number ${i} with a reasonably long descriptive title`,
		}));
		const block = formatPageSnapshot({ page: "List", items }, 2000);
		expect(block.length).toBeLessThanOrEqual(2000 + 40);
		expect(block).toMatch(/\(\d+ more not listed\)$/);
	});

	it("is collected only for registered pages and hidden in transcripts", async () => {
		expect(await collectPageContext("edda:plaza/none")).toBeNull();
		const unregister = registerPageContext("edda:plaza/test", async () => ({
			page: "Test",
			text: "Abstract of the open paper",
		}));
		const block = await collectPageContext("edda:plaza/test");
		unregister();
		expect(block).toContain("Abstract of the open paper");
		expect(await collectPageContext("edda:plaza/test")).toBeNull();
		expect(stripPromptEnvelopeForDisplay(`What is new here?\n\n${block}`)).toBe(
			"What is new here?",
		);
	});
});
