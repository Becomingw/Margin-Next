import { describe, expect, it, vi } from "vitest";
import {
	type ApiResult,
	commands,
	type PoolPaper,
	type PoolSnapshot,
} from "@/lib/core/bindings";
import type { PaperMetadata } from "@/lib/paper/types";
import {
	paperPoolStore,
	poolLibraryIndex,
	poolPaperInLibrary,
	poolPaperSearchText,
	refreshPaperPool,
} from "@/lib/plaza/paper-pool";
import { normalizePlazaPath, PLAZA_SOURCES } from "@/lib/plaza/sources";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: { paperPoolRead: vi.fn() },
}));
const paper: PoolPaper = {
	key: "a".repeat(64),
	title: "Vision research",
	authors: [{ name: "Ada", affiliations: ["Institute"] }],
	year: 2026,
	abstract: "Transfer learning",
	doi: "10.1234/example",
	arxivId: "2304.07193",
	url: null,
	pdfUrl: null,
	tags: [],
	recommendations: [
		{
			source: "Hermes",
			reason: "Useful for segmentation",
			recommendedAt: null,
		},
	],
};

describe("cold paper pool", () => {
	it("replaces retired sources and redirects their saved paths", () => {
		expect(PLAZA_SOURCES.map((s) => s.id)).not.toContain("feeds");
		expect(PLAZA_SOURCES.map((s) => s.id)).not.toContain("arxiv-rec");
		expect(PLAZA_SOURCES.map((s) => s.id)).not.toContain("paper-map");
		expect(normalizePlazaPath("edda:plaza/paper-map")).toBe(
			"edda:plaza/paper-pool",
		);
		expect(normalizePlazaPath("edda:plaza/feeds")).toBe(
			"edda:plaza/paper-pool",
		);
		expect(normalizePlazaPath("edda:plaza/arxiv-rec")).toBe(
			"edda:plaza/paper-pool",
		);
	});
	it("finds existing library entries by normalized identifiers", () => {
		const row = {
			id: "other",
			doi: "https://doi.org/10.1234/EXAMPLE",
			path: "papers/other",
		} as PaperMetadata;
		expect(poolPaperInLibrary(paper, poolLibraryIndex([row]))).toBe(row);
		expect(
			poolPaperInLibrary(
				{ ...paper, doi: null },
				poolLibraryIndex([{ ...row, doi: null, arxiv_id: "2304.07193v2" }]),
			)?.path,
		).toBe("papers/other");
		expect(poolPaperSearchText(paper)).toContain("institute");
		expect(poolPaperSearchText(paper)).toContain("segmentation");
	});
	it("does not replace a new address's results with a late old response", async () => {
		let finishA: (value: ApiResult<PoolSnapshot>) => void = () => {};
		vi.mocked(commands.paperPoolRead).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishA = resolve;
				}),
		);
		const a = refreshPaperPool("/a");
		expect(refreshPaperPool("/a")).toBe(a);
		vi.mocked(commands.paperPoolRead).mockResolvedValueOnce({
			ok: true,
			data: { location: "/b", papers: [paper], warnings: [] },
			error: null,
		});
		await refreshPaperPool("/b");
		finishA({
			ok: true,
			data: { location: "/a", papers: [], warnings: [] },
			error: null,
		});
		await a;
		expect(paperPoolStore.getState().snapshot?.location).toBe("/b");
		expect(paperPoolStore.getState().snapshot?.papers).toHaveLength(1);
	});
});
