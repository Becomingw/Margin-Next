import { describe, expect, it } from "vitest";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	encodeSelectionToken,
	extractSelectionTokens,
	removeSelectionToken,
} from "@/lib/agent/composer-inline-tokens";
import {
	paperQaPaths,
	paperQaSkills,
	referenceContextPaths,
} from "@/lib/agent/paper-qa";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import {
	referencesFromPrompt,
	restoreReferenceHistory,
	saveReferenceHistory,
} from "@/lib/agent/reference-history";
import {
	parseSelectionContext,
	referencePromptBlock,
	type SelectionContext,
	sameSelectionReference,
} from "@/lib/agent/selection-reference";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { selectionLayoutRegionIds } from "@/lib/pdf/selection/reference-context";

const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.02 };
const reference: SelectionContext = {
	id: "ref-one",
	sourcePath: "papers/a",
	origin: "pdf",
	paperAbsPath: "/vault/papers/a",
	page: 2,
	rects: [rect],
	anchors: [
		{ page: 2, rects: [rect] },
		{ page: 3, rects: [{ ...rect, y: 0.1 }] },
	],
	text: "A quoted passage\ncontinued on the next page.",
	pinned: true,
	regionIds: ["text-p2-1"],
};
function storage() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
	};
}

describe("paper references", () => {
	it("hides legacy QA activation and optional-source scaffolding in restored history", () => {
		expect(
			stripPromptEnvelopeForDisplay(
				"/paper-qa\n\n翻译摘要\n\n可用的知识库来源（需要补充上下文时再读取）：\n- papers/a",
			),
		).toBe("翻译摘要");
		expect(
			stripPromptEnvelopeForDisplay(
				"User request:\n$paper-qa\n\nExplain\n\nAvailable Vault sources (read only when additional context is needed):\n- papers/a",
			),
		).toBe("Explain");
	});
	it("does not show the injected QA skill in restored user messages", () => {
		expect(
			stripPromptEnvelopeForDisplay(
				"User request:\nWhy?\n\n## Active local skills (Edda-injected)\n### skill:paper-qa\nInternal rules",
			),
		).toBe("Why?");
	});
	it("preserves all page anchors through inline drafts", () => {
		expect(
			extractSelectionTokens(`Explain ${encodeSelectionToken(reference)}`),
		).toEqual([reference]);
	});
	it("removes a restored reference by id despite different JSON property order", () => {
		const token = encodeSelectionToken({ text: reference.text, ...reference });
		expect(removeSelectionToken(`Before ${token} after`, reference.id)).toBe(
			"Before  after",
		);
	});
	it("does not conflate identical text at different page positions", () => {
		expect(sameSelectionReference(reference, { ...reference, id: "new" })).toBe(
			true,
		);
		expect(sameSelectionReference(reference, { ...reference, page: 8 })).toBe(
			false,
		);
		expect(
			sameSelectionReference(reference, {
				...reference,
				anchors: [{ page: 2, rects: [{ ...rect, y: 0.7 }] }],
			}),
		).toBe(false);
	});
	it("keeps legacy references readable and discards invalid geometry", () => {
		const parsed = parseSelectionContext({
			...reference,
			page: -1,
			anchors: [{ page: 0, rects: [rect] }],
			rects: [{ ...rect, w: Number.NaN }],
		});
		expect(parsed?.text).toBe(reference.text);
		expect(parsed?.page).toBeUndefined();
		expect(parsed?.anchors).toBeUndefined();
		expect(parsed?.rects).toBeUndefined();
	});
	it("sends concise source hints without rectangles or local absolute paths", () => {
		const prompt = referencePromptBlock(reference);
		expect(prompt).toContain("papers/a (page 2)");
		expect(prompt).toContain("text-p2-1");
		expect(prompt).toContain("pages 2, 3");
		expect(prompt).not.toContain("/vault/");
		expect(prompt).not.toContain('"rects"');
		expect(prompt).not.toContain("0.1");
		expect(
			referencesFromPrompt(`Question\n\n${prompt}`, "msg")[0],
		).toMatchObject({ sourcePath: "papers/a", page: 2, text: reference.text });
	});
	it("uses a quote's paper and explicit mentions instead of the newly focused PDF", () => {
		expect(
			referenceContextPaths(
				[reference],
				["papers/b", "notes/compare.md"],
				["notes/compare.md"],
			),
		).toEqual(["papers/a", "notes/compare.md"]);
		expect(referenceContextPaths([], ["papers/b"], [], ["papers/a"])).toEqual([
			"papers/a",
		]);
		expect(
			paperQaPaths([{ ...reference, sourcePath: "papers/b" }], ["papers/a"]),
		).toEqual(["papers/b", "papers/a"]);
		expect(paperQaSkills([], true)).toEqual(["paper-qa"]);
		expect(paperQaSkills(["custom"], true)).toEqual(["custom"]);
		expect(paperQaSkills([], false)).toEqual([]);
	});
	it("matches already-loaded layout blocks by page and overlap, not neighboring columns", () => {
		const region = (
			id: string,
			pageIndex: number,
			x: number,
			readingOrder: number,
		) =>
			({
				id,
				pageIndex,
				bbox: { x, y: 0, w: 0.45, h: 0.5 },
				kind: "text",
				readingOrder,
			}) as PdfLayoutRegion;
		const ids = selectionLayoutRegionIds(reference.anchors ?? [], [
			region("next", 2, 0.05, 3),
			region("left", 1, 0.05, 2),
			region("other-column", 1, 0.55, 1),
			region("other-page", 5, 0.05, 0),
		]);
		expect(ids).toEqual(["left", "next"]);
	});
	it("restores exact quotes for repeated questions and isolates vaults and agents", () => {
		const s = storage();
		const lines: ChatLine[] = [
			{ id: "u1", kind: "user", text: "Why?", references: [reference] },
			{
				id: "u2",
				kind: "user",
				text: "Why?",
				references: [{ ...reference, id: "ref-two", page: 4 }],
			},
		];
		saveReferenceHistory(s, "vault", "agent", "provider-session", lines);
		const loaded: ChatLine[] = lines.map((line) => ({
			id: line.id,
			kind: "user",
			text: "Why?",
		}));
		expect(
			restoreReferenceHistory(s, "vault", "agent", "provider-session", loaded),
		).toEqual(lines);
		expect(
			restoreReferenceHistory(
				s,
				"other-vault",
				"agent",
				"provider-session",
				loaded,
			),
		).toEqual(loaded);
		expect(
			restoreReferenceHistory(
				s,
				"vault",
				"other-agent",
				"provider-session",
				loaded,
			),
		).toEqual(loaded);
		saveReferenceHistory(s, "vault", "agent", "provider-session", []);
		expect(
			restoreReferenceHistory(s, "vault", "agent", "provider-session", loaded),
		).toEqual(lines);
	});
	it("does not attach old geometry to an edited or unrelated question", () => {
		const s = storage();
		saveReferenceHistory(s, "v", "a", "s", [
			{ id: "u", kind: "user", text: "Original", references: [reference] },
		]);
		const edited: ChatLine[] = [
			{ id: "u", kind: "user", text: "Different question" },
		];
		expect(restoreReferenceHistory(s, "v", "a", "s", edited)).toEqual(edited);
	});
});
