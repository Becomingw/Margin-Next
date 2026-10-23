import { describe, expect, it } from "vitest";
import {
	collectWebState,
	mapFormerWebState,
	restoreWebState,
} from "@/lib/shell/app-rename";

function memoryStorage(init: Record<string, string> = {}) {
	const data = new Map(Object.entries(init));
	return {
		data,
		get length() {
			return data.size;
		},
		key: (i: number) => [...data.keys()][i] ?? null,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
}

describe("app rename web state", () => {
	it("collects only the build's own keys", () => {
		const storage = memoryStorage({
			"agentero-open-tabs": "[]",
			"agentero.paperInfoHeight": "240",
			i18nextLng: "en",
			agenterox: "nope",
		});
		expect(collectWebState(storage, "agentero").map((e) => e.key)).toEqual([
			"agentero-open-tabs",
			"agentero.paperInfoHeight",
		]);
	});

	it("rewrites key prefixes and persisted pseudo paths", () => {
		const mapped = mapFormerWebState(
			[
				{
					key: "agentero-open-tabs",
					value: '["agentero:library","/v/papers/a/a.pdf"]',
				},
				{ key: "agentero.paperInfoHeight", value: "240" },
				{ key: "other-key", value: "x" },
			],
			"agentero",
			"edda",
		);
		expect(mapped).toEqual([
			{ key: "edda-open-tabs", value: '["edda:library","/v/papers/a/a.pdf"]' },
			{ key: "edda.paperInfoHeight", value: "240" },
		]);
	});

	it("never overwrites state the renamed build already has", () => {
		const storage = memoryStorage({ "edda-open-tabs": "[]" });
		const written = restoreWebState(storage, [
			{ key: "edda-open-tabs", value: '["edda:library"]' },
			{ key: "edda-recent-vaults", value: '["/v"]' },
		]);
		expect(written).toBe(1);
		expect(storage.data.get("edda-open-tabs")).toBe("[]");
		expect(storage.data.get("edda-recent-vaults")).toBe('["/v"]');
	});
});
