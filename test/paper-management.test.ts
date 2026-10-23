import { open } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { resolvePapersParentDir } from "@/lib/paper/detect";
import { attachLibraryPdf, createManualPaper } from "@/lib/paper/management";
import type { PaperLibraryRow } from "@/lib/paper/types";
import { isManagedPaperLocation } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";
import { reloadPaperPdf } from "@/lib/workspace/actions";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: { paperCreateManual: vi.fn(), paperAttachPdf: vi.fn() },
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: vi.fn(() => "/vault"),
	refreshTree: vi.fn(),
}));
vi.mock("@/lib/workspace/actions", () => ({ reloadPaperPdf: vi.fn() }));
vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifySuccess: vi.fn(),
}));
vi.mock("@/lib/paper/library-store", () => ({
	libraryStore: { getState: () => ({ editMetaDraft: null }) },
	setEditMetaDraft: vi.fn(),
	refreshLibrary: vi.fn(),
}));

describe("Library explicit paper management", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getVaultPath).mockReturnValue("/vault");
	});
	const paper = {
		id: "selected",
		path: "papers/selected",
		title: "Selected",
		has_pdf: false,
	} as PaperLibraryRow;
	it("creates only metadata using the same validated patch shape as editing", async () => {
		vi.mocked(commands.paperCreateManual).mockResolvedValue({
			ok: true,
			data: {} as never,
			error: null,
		});
		await createManualPaper({
			title: "My reference",
			authors: ["Ada"],
			year: "2026",
		});
		expect(commands.paperCreateManual).toHaveBeenCalledWith(
			"/vault",
			expect.objectContaining({
				title: "My reference",
				authors: ["Ada"],
				year: "2026",
				doi: null,
			}),
		);
		expect(commands.paperAttachPdf).not.toHaveBeenCalled();
	});
	it("attaches to the selected path instead of importing a new paper", async () => {
		vi.mocked(open).mockResolvedValue("/download/other-name.pdf");
		vi.mocked(commands.paperAttachPdf).mockResolvedValue({
			ok: true,
			data: { path: paper.path, backupPath: null },
			error: null,
		});
		await attachLibraryPdf(paper);
		expect(commands.paperAttachPdf).toHaveBeenCalledWith(
			"/vault",
			"papers/selected",
			"/download/other-name.pdf",
			false,
		);
		expect(reloadPaperPdf).toHaveBeenCalledWith("/vault/papers/selected");
		expect(commands.paperCreateManual).not.toHaveBeenCalled();
	});
	it("requests replacement only for an existing PDF", async () => {
		vi.mocked(open).mockResolvedValue("/new.pdf");
		vi.mocked(commands.paperAttachPdf).mockResolvedValue({
			ok: true,
			data: { path: paper.path, backupPath: ".edda/pdf-backups/test" },
			error: null,
		});
		await attachLibraryPdf({ ...paper, has_pdf: true });
		expect(commands.paperAttachPdf).toHaveBeenCalledWith(
			"/vault",
			paper.path,
			"/new.pdf",
			true,
		);
	});
	it("does nothing when the picker is cancelled or the vault changes", async () => {
		vi.mocked(open).mockResolvedValue(null);
		await attachLibraryPdf(paper);
		vi.mocked(open).mockImplementation(async () => {
			vi.mocked(getVaultPath).mockReturnValue("/other");
			return "/new.pdf";
		});
		await attachLibraryPdf(paper);
		expect(commands.paperAttachPdf).not.toHaveBeenCalled();
		expect(reloadPaperPdf).not.toHaveBeenCalled();
	});
	it("does not clear the current viewer after a failed replacement", async () => {
		vi.mocked(open).mockResolvedValue("/invalid.pdf");
		vi.mocked(commands.paperAttachPdf).mockResolvedValue({
			ok: false,
			data: null,
			error: { code: "invalid_pdf", message: "Invalid PDF" },
		});
		await attachLibraryPdf({ ...paper, has_pdf: true });
		expect(notifyError).toHaveBeenCalled();
		expect(reloadPaperPdf).not.toHaveBeenCalled();
	});
	it("protects paper storage while leaving notes and attachments nestable", () => {
		expect(resolvePapersParentDir("/vault", "/vault/papers/vit", [])).toBe(
			"papers",
		);
		expect(isManagedPaperLocation("C:\\vault", "C:\\vault\\papers")).toBe(true);
		expect(isManagedPaperLocation("/vault", "/vault/papers/vit")).toBe(true);
		expect(isManagedPaperLocation("/vault", "/vault/notes/vit")).toBe(false);
		expect(
			isManagedPaperLocation("/vault", "/vault/papers/p/attachments/code"),
		).toBe(false);
	});
});
