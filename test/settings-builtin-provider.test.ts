import { describe, expect, it, vi } from "vitest";

import { BUILTIN_PROVIDER_ID } from "@/lib/core/builtin";
import {
	isProviderCardConfigurable,
	PARSER_PROVIDERS,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_LAYOUT_SETTINGS,
	LAYOUT_BACKENDS,
	LAYOUT_PROVIDER_IDS,
	PARSER_BACKENDS,
} from "@/lib/pdf/layout/settings";
import { DEFAULT_TRANSLATE_SETTINGS } from "@/lib/translate/defaults";
import { probeFreeMtProviders } from "@/lib/translate/probe";
import { FREE_MT_PROVIDER_IDS } from "@/lib/translate/types";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
	isMacOS: () => false,
	isMobileApp: () => false,
	getPlatformOS: () => "other",
}));

describe("built-in provider id", () => {
	it("matches the Host literal", () => {
		expect(BUILTIN_PROVIDER_ID).toBe("builtin");
	});

	it("is a free-MT translate provider and a parser backend", () => {
		expect(FREE_MT_PROVIDER_IDS).toContain("builtin");
		expect(PARSER_BACKENDS).toContain("builtin");
		expect(LAYOUT_PROVIDER_IDS).toContain("builtin");
	});

	it("is never a layout-analysis backend (stays on local ONNX)", () => {
		expect(LAYOUT_BACKENDS).not.toContain("builtin");
	});

	it("renders no credential card (all supports false)", () => {
		const card = PARSER_PROVIDERS.builtin;
		expect(card).not.toBeNull();
		expect(card?.requiresApiKey).toBe(false);
		expect(card?.supportsBaseUrl).toBe(false);
		expect(card?.supportsModel).toBe(false);
		expect(card?.supportsPrompt).toBe(false);
		expect(card?.supportsLanguage).toBe(false);
		expect(card?.supportsOcr).toBe(false);
		expect(card && isProviderCardConfigurable(card)).toBe(false);
		// A real provider card stays configurable.
		const paddle = PARSER_PROVIDERS.paddle;
		expect(paddle && isProviderCardConfigurable(paddle)).toBe(true);
	});

	it("is excluded from free-MT availability probes", async () => {
		const result = await probeFreeMtProviders();
		expect("builtin" in result).toBe(false);
		expect(result.google).toBe(false);
	});
});

describe("defaults (browser-dev, no Host key)", () => {
	it("keeps translate provider and parser backend off the built-in", () => {
		expect(DEFAULT_TRANSLATE_SETTINGS.provider).toBe("tencenttransmart");
		expect(DEFAULT_LAYOUT_SETTINGS.backend).toBe("local");
		expect(DEFAULT_LAYOUT_SETTINGS.parserBackend).toBe("local");
	});
});
