import { describe, expect, it, vi } from "vitest";
import { writeVaultBytes, writeVaultFile } from "@/lib/vault/fs";
import {
	isInsidePaperCodeSnapshot,
	isPaperCodePath,
} from "@/lib/vault/paper-code-path";

vi.mock("@tauri-apps/plugin-fs", () => ({
	readFile: vi.fn(),
	readTextFile: vi.fn(),
	writeTextFile: vi.fn(),
	writeFile: vi.fn(),
}));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));

describe("paper code snapshot read-only boundary", () => {
	it("blocks text and binary edits, including Windows and remote paths", async () => {
		for (const path of [
			"/vault/papers/p/code/github-example/files/README.md",
			"C:\\vault\\papers\\p\\code\\github-example\\files\\train.py",
			"remote:session/papers/p/code/github-example/files/image.png",
		]) {
			expect(isPaperCodePath(path)).toBe(true);
			expect(isInsidePaperCodeSnapshot(path)).toBe(true);
			await expect(writeVaultFile(path, "changed")).rejects.toThrow();
			await expect(
				writeVaultBytes(path, new Uint8Array([1])),
			).rejects.toThrow();
		}
	});
	it("allows recycling a whole snapshot and leaves notes/attachments outside the boundary", () => {
		expect(
			isInsidePaperCodeSnapshot("/vault/papers/p/code/github-example"),
		).toBe(false);
		for (const path of [
			"/vault/papers/p/NOTES.md",
			"/vault/papers/p/attachments/code/example.md",
			"/vault/notes/code/readme.md",
		])
			expect(isPaperCodePath(path)).toBe(false);
	});
});
