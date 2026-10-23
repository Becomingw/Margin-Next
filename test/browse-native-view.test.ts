import { afterEach, describe, expect, it, vi } from "vitest";
import {
	browseViewLabel,
	createViewCoverageProbe,
	isViewCovered,
	normalizeSiteUrl,
	siteNameFromUrl,
} from "@/lib/browse/native-view";
import { pushOverlay } from "@/lib/core/overlay-stack";

describe("browse site addresses", () => {
	it("accepts bare hosts and http(s), rejects the rest", () => {
		expect(normalizeSiteUrl("link.springer.com")).toBe(
			"https://link.springer.com/",
		);
		expect(normalizeSiteUrl(" http://example.org/a?b=1 ")).toBe(
			"http://example.org/a?b=1",
		);
		expect(normalizeSiteUrl("ftp://example.org")).toBeNull();
		expect(normalizeSiteUrl("javascript:alert(1)")).toBeNull();
		expect(normalizeSiteUrl("intranet")).toBeNull();
		expect(normalizeSiteUrl("")).toBeNull();
	});

	it("names sites by host and keeps view labels plain", () => {
		expect(siteNameFromUrl("https://www.ieeexplore.ieee.org/")).toBe(
			"ieeexplore.ieee.org",
		);
		expect(browseViewLabel("main", "a1b2")).toBe("browse-main-a1b2");
		expect(browseViewLabel("win:2", "x/y")).toBe("browse-win_2-x_y");
	});
});

describe("native browse visibility", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("ignores an overlapping floating surface that is mounted but invisible", () => {
		vi.stubGlobal("document", {
			querySelectorAll: () => [
				{
					querySelector: () => null,
					getBoundingClientRect: () => ({
						left: 10,
						right: 80,
						top: 45,
						bottom: 70,
						width: 70,
					}),
					checkVisibility: () => false,
				},
			],
		});
		expect(
			isViewCovered({ left: 0, top: 50, right: 500, bottom: 500 } as DOMRect),
		).toBe(false);
	});
	it("does not cover unrelated views for a registered non-modal panel", () => {
		vi.stubGlobal("document", { querySelectorAll: () => [] });
		const off = pushOverlay({
			id: "browse-test",
			close: () => {},
			modal: false,
		});
		try {
			expect(isViewCovered({} as DOMRect)).toBe(false);
		} finally {
			off();
		}
		const offModal = pushOverlay({ id: "browse-test-modal", close: () => {} });
		try {
			expect(isViewCovered({} as DOMRect)).toBe(true);
		} finally {
			offModal();
		}
	});
	it("hands off overlapping tooltip pixels when native snapshots are supported", () => {
		vi.stubGlobal(
			"MutationObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal("document", {
			body: {},
			querySelectorAll: () => [
				{
					querySelector: () => ({}),
					getBoundingClientRect: () => ({
						left: 10,
						right: 80,
						top: 45,
						bottom: 70,
						width: 70,
					}),
				},
			],
		});
		const probe = createViewCoverageProbe(true);
		expect(
			probe.isCovered({ left: 0, top: 50, right: 500, bottom: 500 } as DOMRect),
		).toBe(true);
		probe.dispose();
	});
	it("reuses layer discovery between frames and refreshes on menu insertion/removal", () => {
		let invalidate = () => {};
		const disconnect = vi.fn();
		vi.stubGlobal(
			"MutationObserver",
			class {
				constructor(callback: () => void) {
					invalidate = callback;
				}
				observe() {}
				disconnect = disconnect;
			},
		);
		let left = 10;
		const menu = {
			querySelector: () => null,
			getBoundingClientRect: () => ({
				left,
				right: left + 70,
				top: 45,
				bottom: 70,
				width: 70,
			}),
		};
		let layers: (typeof menu)[] = [];
		const querySelectorAll = vi.fn(() => layers);
		vi.stubGlobal("document", { body: {}, querySelectorAll });
		const rect = { left: 0, top: 50, right: 500, bottom: 500 } as DOMRect;
		const probe = createViewCoverageProbe();
		for (let i = 0; i < 120; i++) expect(probe.isCovered(rect)).toBe(false);
		expect(querySelectorAll).toHaveBeenCalledTimes(1);
		layers = [menu];
		invalidate();
		expect(probe.isCovered(rect)).toBe(true);
		// Position-only animation is still measured on every frame.
		left = 600;
		expect(probe.isCovered(rect)).toBe(false);
		expect(querySelectorAll).toHaveBeenCalledTimes(2);
		layers = [];
		invalidate();
		expect(probe.isCovered(rect)).toBe(false);
		probe.dispose();
		expect(disconnect).toHaveBeenCalledOnce();
	});
	it("keeps the page visible for tooltips but hides it for overlapping menus", () => {
		const rect = { left: 0, top: 50, right: 500, bottom: 500 } as DOMRect;
		const box = { left: 10, top: 45, right: 80, bottom: 70, width: 70 };
		const tooltip = {
			querySelector: () => ({}),
			getBoundingClientRect: () => box,
		};
		const menu = {
			querySelector: () => null,
			getBoundingClientRect: () => box,
		};
		vi.stubGlobal("document", { querySelectorAll: () => [tooltip] });
		expect(isViewCovered(rect)).toBe(false);
		vi.stubGlobal("document", { querySelectorAll: () => [tooltip, menu] });
		expect(isViewCovered(rect)).toBe(true);
		vi.stubGlobal("document", {
			querySelectorAll: () => [
				{ ...menu, getBoundingClientRect: () => ({ ...box, bottom: 49 }) },
			],
		});
		expect(isViewCovered(rect)).toBe(false);
	});
});
