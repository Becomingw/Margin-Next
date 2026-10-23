import { describe, expect, it, vi } from "vitest";
import {
	annotationGeneration,
	preparePdfReplacement,
	saveAnnotationItems,
} from "@/lib/pdf/highlight/annotation-store";
import { writeVaultFile } from "@/lib/vault";

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault", () => ({
	normalizePathKey: (path: string) => path.replace(/\\/g, "/").toLowerCase(),
	joinVaultPath: (a: string, b: string) => `${a}/${b}`,
	readVaultFile: vi.fn(),
	writeVaultFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ remove: vi.fn() }));

describe("PDF replacement annotation writers", () => {
	it("drains in-flight writes and rejects exports from the old PDF", async () => {
		const paper = "/vault/papers/replaced";
		const generation = annotationGeneration(paper);
		let done: () => void = () => {};
		vi.mocked(writeVaultFile).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					done = resolve;
				}),
		);
		const write = saveAnnotationItems(paper, [], generation);
		let ready = false;
		const prepare = preparePdfReplacement(paper).then((finish) => {
			ready = true;
			return finish;
		});
		await Promise.resolve();
		expect(ready).toBe(false);
		done();
		await write;
		const finish = await prepare;
		finish(true);
		await expect(saveAnnotationItems(paper, [], generation)).rejects.toThrow();
		await expect(
			saveAnnotationItems(paper, [], annotationGeneration(paper)),
		).resolves.toBeUndefined();
	});
	it("lets the existing viewer keep saving when replacement fails", async () => {
		const paper = "/vault/papers/failed";
		const generation = annotationGeneration(paper);
		const finish = await preparePdfReplacement(paper);
		finish(false);
		await expect(
			saveAnnotationItems(paper, [], generation),
		).resolves.toBeUndefined();
	});
});
