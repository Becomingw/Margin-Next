import { afterEach, expect, it, vi } from "vitest";
import { applyUiTheme, UI_THEMES } from "@/lib/ui/theme";

afterEach(() => vi.unstubAllGlobals());

it("keeps the stylesheet intact on repeated settings broadcasts and honors the latest selection", async () => {
	let current: ReturnType<typeof element> | null = null;
	let writes = 0;
	const head = {
		appendChild: (el: ReturnType<typeof element>) => {
			current = el;
			el.parentNode = head;
		},
	};
	function element() {
		let text = "";
		return {
			id: "",
			parentNode: null as unknown,
			nextSibling: null,
			get textContent() {
				return text;
			},
			set textContent(value: string) {
				text = value;
				writes++;
			},
			remove: () => {
				current = null;
			},
		};
	}
	vi.stubGlobal("document", {
		head,
		getElementById: () => current,
		createElement: element,
	});
	const name = UI_THEMES[0].name;
	await applyUiTheme(name);
	for (let i = 0; i < 100; i++) await applyUiTheme(name);
	expect(writes).toBe(1);
	const pending = applyUiTheme(name);
	await applyUiTheme("default");
	await pending;
	expect(current).toBeNull();
	await Promise.all([applyUiTheme(name), applyUiTheme(name)]);
	expect(writes).toBe(2);
});
