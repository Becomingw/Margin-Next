import { describe, expect, it } from "vitest";
import {
	isMissingLocalPdf,
	libraryLayout,
	resetColumnWidths,
	setColumnPairWidths,
} from "@/components/library/library-row-utils";
import type { PaperLibraryRow } from "@/lib/paper";
import { DEFAULT_LIBRARY_COLUMNS } from "@/lib/settings/types";

function row(has_pdf: boolean | undefined): PaperLibraryRow {
	return {
		path: "papers/x",
		id: "x",
		type: "arxiv",
		title: "X",
		authors: [],
		tags: [],
		status: "completed",
		is_read: false,
		added_at: "",
		updated_at: "",
		has_pdf,
	};
}

describe("isMissingLocalPdf", () => {
	it("reports a probed-absent PDF as missing", () => {
		expect(isMissingLocalPdf(row(false))).toBe(true);
	});

	it("reports a probed-present PDF as there", () => {
		expect(isMissingLocalPdf(row(true))).toBe(false);
	});

	// remote_paper_list returns bare records, so nothing ever probed the vault
	// for a local PDF; treating that as "missing" would badge every remote paper.
	it("does not report an unprobed row as missing", () => {
		expect(isMissingLocalPdf(row(undefined))).toBe(false);
	});
});

describe("libraryLayout", () => {
	const keys = (widthRem: number) =>
		libraryLayout(widthRem, DEFAULT_LIBRARY_COLUMNS).columns.map((c) => c.key);

	it("drops secondary columns before switching to the list", () => {
		expect(keys(80)).toContain("id");
		expect(keys(62)).not.toContain("id");
		expect(keys(62)).toContain("citations");
		expect(keys(50)).not.toContain("publication");
		expect(keys(50)).toContain("title");
	});

	it("lists below 48rem and keeps every chosen field for the meta line", () => {
		const narrow = libraryLayout(40, DEFAULT_LIBRARY_COLUMNS);
		expect(narrow.list).toBe(true);
		expect(narrow.columns).toEqual(DEFAULT_LIBRARY_COLUMNS);
		// Unmeasured: plain table.
		expect(libraryLayout(0, DEFAULT_LIBRARY_COLUMNS).list).toBe(false);
	});
});

describe("column widths", () => {
	it("sets only the dragged pair and resets it back to the default", () => {
		const sized = setColumnPairWidths(DEFAULT_LIBRARY_COLUMNS, {
			title: 50,
			authors: 10,
		});
		expect(sized.find((c) => c.key === "title")?.width).toBe(50);
		expect(sized.find((c) => c.key === "authors")?.width).toBe(10);
		expect(sized.find((c) => c.key === "year")?.width).toBeUndefined();
		const reset = resetColumnWidths(sized, ["title", "authors"]);
		expect(reset).toEqual(DEFAULT_LIBRARY_COLUMNS);
	});
});
