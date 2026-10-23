import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
	type PdfTranslationCard,
	translationCardFrame,
	type UsePdfSelectionTranslateOptions,
	usePdfSelectionTranslate,
} from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { attachAgentRun, cancelAgentRun, runOnce } from "@/lib/agent";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import { writePdfTranslate } from "@/lib/pdf/translate";
import { loadSettings } from "@/lib/settings";
import { prepareTranslateTask, runTranslate } from "@/lib/translate";

const { cleanups, states } = vi.hoisted(() => ({
	cleanups: [] as (() => void)[],
	states: [] as unknown[],
}));
vi.mock("react", () => ({
	useState: (value: unknown) => {
		const index = states.length;
		states.push(value);
		return [
			value,
			(next: unknown) => {
				states[index] = next;
			},
		];
	},
	useRef: (current: unknown) => ({ current }),
	useCallback: (callback: unknown) => callback,
	useEffect: (effect: () => (() => void) | undefined) => {
		const cleanup = effect();
		if (cleanup) cleanups.push(cleanup);
	},
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/pdf/marks/io", () => ({ createMarkStore: () => ({}) }));
vi.mock("@/lib/settings", () => ({ loadSettings: vi.fn() }));
vi.mock("@/lib/agent", async () => ({
	...(await import("@/lib/agent/run-attach")),
	attachAgentRun: vi.fn(),
	cancelAgentRun: vi.fn().mockResolvedValue(undefined),
	listAgents: vi.fn().mockResolvedValue(null),
	runOnce: vi.fn(),
}));
vi.mock("@/lib/agent/api", () => ({
	cancelAgentRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/pdf/translate", async () => ({
	...(await import("@/lib/pdf/translate/io")),
	writePdfTranslate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/translate", () => ({
	prepareTranslateTask: vi.fn(),
	runTranslate: vi.fn(),
	buildTranslatePrompt: () => "Translate",
	displayTranslateError: (message: string) => message,
	resolveTranslateAgent: () => ({ agentId: "test-agent", modelId: "model" }),
}));

const anchor: PdfAskAnchor = {
	page: 1,
	quote: "Selected paragraph",
	rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.03 }],
	trigger: "selection",
};
const pages = [
	{
		pageIndex: 0,
		rect: { origin: { x: 10, y: 20 }, size: { width: 40, height: 3 } },
		segmentRects: [],
	},
] as unknown as FormattedSelection[];
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
function harness() {
	const options: UsePdfSelectionTranslateOptions = {
		paperAbsPath: "/vault/paper",
		paperRelPath: "paper",
		vaultPath: "/vault",
		getScreen: vi.fn(() => ({ x: 100, y: 200 })),
		onOpen: vi.fn(),
		onConvertToNote: vi.fn().mockResolvedValue(undefined),
	};
	const index = states.length;
	// biome-ignore lint/correctness/useHookAtTopLevel: Deterministic callback harness with mocked React hooks.
	const view = usePdfSelectionTranslate(options);
	return {
		...view,
		options,
		readCards: () => states[index] as PdfTranslationCard[],
		select: (next = anchor) => view.translateSelection(next, pages),
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	cleanups.length = 0;
	states.length = 0;
	vi.mocked(loadSettings).mockReturnValue({
		translate: { provider: "google", providerConfigs: {} },
	} as ReturnType<typeof loadSettings>);
	vi.mocked(prepareTranslateTask).mockImplementation((partial) => ({
		task: { ...partial, sourceLang: "auto", targetLang: "zh-CN" },
		providerId: loadSettings().translate.provider,
		targetLangName: "Chinese",
	}));
});

it("deduplicates reselections and caches completed results only for this reading session", async () => {
	const request = deferred<string>();
	vi.mocked(runTranslate).mockReturnValue(request.promise);
	const h = harness();
	h.select();
	h.select({ ...anchor, quote: " Selected  paragraph " });
	expect(runTranslate).toHaveBeenCalledTimes(1);
	expect(h.readCards()).toHaveLength(1);
	request.resolve("译文");
	await flush();
	const id = h.readCards()[0].record.id;
	h.closeCard(id);
	h.select();
	expect(runTranslate).toHaveBeenCalledTimes(1);
	expect(h.readCards()[0]).toMatchObject({
		visible: true,
		record: { id, result: "译文" },
	});
	expect(writePdfTranslate).not.toHaveBeenCalled();
	harness().select();
	expect(runTranslate).toHaveBeenCalledTimes(2);
});

it("keeps a pinned card and its running request when a different paragraph is selected", async () => {
	const first = deferred<string>();
	const second = deferred<string>();
	vi.mocked(runTranslate)
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise);
	const h = harness();
	h.select();
	const id = h.readCards()[0].record.id;
	h.pinCard(id, true);
	h.select({ ...anchor, quote: "Next paragraph" });
	expect(h.readCards().filter((card) => card.visible)).toHaveLength(2);
	first.resolve("Fixed result");
	await flush();
	expect(h.readCards().find((card) => card.record.id === id)).toMatchObject({
		pinned: true,
		visible: true,
		streaming: false,
		record: { result: "Fixed result" },
	});
	second.resolve("Next result");
	await flush();
	h.dismissUnpinned();
	expect(
		h
			.readCards()
			.filter((card) => card.visible)
			.map((card) => card.record.id),
	).toEqual([id]);
	expect(writePdfTranslate).not.toHaveBeenCalled();
});

it.each([
	"resolve",
	"reject",
] as const)("ignores an unpinned replacement's late %s", async (outcome) => {
	const old = deferred<string>();
	const current = deferred<string>();
	vi.mocked(runTranslate)
		.mockReturnValueOnce(old.promise)
		.mockReturnValueOnce(current.promise);
	const h = harness();
	h.select();
	h.select({ ...anchor, quote: "Next paragraph" });
	if (outcome === "resolve") old.resolve("Stale");
	else old.reject(new Error("Stale error"));
	await flush();
	expect(h.readCards().find((card) => card.visible)?.streaming).toBe(true);
	expect(h.readCards().some((card) => card.record.result === "Stale")).toBe(
		false,
	);
	expect(notifyError).not.toHaveBeenCalled();
	current.resolve("Current");
	await flush();
	expect(h.readCards().find((card) => card.visible)?.record.result).toBe(
		"Current",
	);
});

it("reuses the card but retranslates after language changes", async () => {
	vi.mocked(runTranslate).mockResolvedValue("译文");
	const h = harness();
	h.select();
	await flush();
	const id = h.readCards()[0].record.id;
	vi.mocked(prepareTranslateTask).mockReturnValue({
		task: { text: anchor.quote ?? "", sourceLang: "auto", targetLang: "en" },
		providerId: "google",
		targetLangName: "English",
	});
	h.select();
	await flush();
	expect(runTranslate).toHaveBeenCalledTimes(2);
	expect(h.readCards()).toHaveLength(1);
	expect(h.readCards()[0].record.id).toBe(id);
});

it("converts once using the captured source pages, and closes only after saving", async () => {
	vi.mocked(runTranslate).mockResolvedValue("译文");
	const h = harness();
	h.select();
	await flush();
	const id = h.readCards()[0].record.id;
	const save = deferred<void>();
	vi.mocked(h.options.onConvertToNote).mockReturnValue(save.promise);
	const conversion = h.convertToNote(id);
	await h.convertToNote(id);
	h.closeCard(id);
	expect(h.options.onConvertToNote).toHaveBeenCalledExactlyOnceWith(
		pages,
		anchor.quote,
		"译文",
	);
	expect(h.readCards()[0]).toMatchObject({ visible: true, converting: true });
	save.resolve();
	await conversion;
	expect(h.readCards()).toHaveLength(0);
	expect(writePdfTranslate).not.toHaveBeenCalled();
});

it("keeps the card after a failed note save so conversion can be retried", async () => {
	vi.mocked(runTranslate).mockResolvedValue("译文");
	const h = harness();
	h.select();
	await flush();
	const id = h.readCards()[0].record.id;
	vi.mocked(h.options.onConvertToNote).mockRejectedValueOnce(
		new Error("Disk full"),
	);
	await h.convertToNote(id);
	expect(h.readCards()[0]).toMatchObject({ visible: true, converting: false });
	expect(notifyError).toHaveBeenCalledWith("Disk full");
	await h.convertToNote(id);
	expect(h.readCards()).toHaveLength(0);
});

it.each(["close", "unmount"])("drops late results after %s", async (action) => {
	const request = deferred<string>();
	vi.mocked(runTranslate).mockReturnValue(request.promise);
	const h = harness();
	h.select();
	if (action === "close") h.closeCard(h.readCards()[0].record.id);
	else for (const cleanup of cleanups) cleanup();
	request.resolve("Late");
	await flush();
	expect(h.readCards().some((card) => card.record.result)).toBe(false);
	expect(writePdfTranslate).not.toHaveBeenCalled();
});

it("cancels late Agent acceptance without replacing the new request", async () => {
	loadSettings().translate.provider = "agent";
	const old = deferred<Awaited<ReturnType<typeof runOnce>>>();
	vi.mocked(runOnce).mockReturnValueOnce(old.promise);
	const h = harness();
	h.select();
	await flush();
	loadSettings().translate.provider = "google";
	vi.mocked(runTranslate).mockReturnValue(deferred<string>().promise);
	h.select({ ...anchor, quote: "Next paragraph" });
	old.resolve({ sessionId: "old" } as Awaited<ReturnType<typeof runOnce>>);
	await flush();
	expect(cancelAgentRun).toHaveBeenCalledWith("old");
	expect(attachAgentRun).not.toHaveBeenCalled();
	expect(h.readCards().find((card) => card.visible)?.streaming).toBe(true);
});

it("keeps pinned cards at their placed offset while the source scrolls", async () => {
	vi.mocked(runTranslate).mockResolvedValue("译文");
	const h = harness();
	h.select();
	await flush();
	const id = h.readCards()[0].record.id;
	h.pinCard(id, true);
	// Dropped 500px right of / 40px above its source anchor at (100, 200).
	h.moveCard(id, { left: 600, top: 160, width: 260, height: 180 });
	vi.mocked(h.options.getScreen).mockReturnValue({ x: 100, y: -300 });
	h.rePlaceCards();
	const card = h.readCards()[0];
	expect(translationCardFrame(card)).toEqual({
		left: 600,
		top: -340,
		width: 260,
		height: 180,
	});
	// Source page unmounted (virtualized): the card waits off screen.
	vi.mocked(h.options.getScreen).mockReturnValue(null);
	h.rePlaceCards();
	expect(h.readCards()[0].anchored).toBe(false);
	// Unpinning snaps it back beside the source.
	vi.mocked(h.options.getScreen).mockReturnValue({ x: 300, y: 400 });
	h.pinCard(id, false);
	h.rePlaceCards();
	expect(h.readCards()[0]).toMatchObject({
		screen: { x: 300, y: 400 },
		anchored: true,
		offset: null,
	});
});

it("streams and settles pinned Agent cards independently without losing adjacent chunks", async () => {
	loadSettings().translate.provider = "agent";
	vi.mocked(runOnce)
		.mockResolvedValueOnce({ sessionId: "first" } as Awaited<
			ReturnType<typeof runOnce>
		>)
		.mockResolvedValueOnce({ sessionId: "second" } as Awaited<
			ReturnType<typeof runOnce>
		>);
	const h = harness();
	h.select();
	await flush();
	const id = h.readCards()[0].record.id;
	h.pinCard(id, true);
	h.select({ ...anchor, quote: "Second paragraph" });
	await flush();
	const first = vi.mocked(attachAgentRun).mock.calls[0][0];
	const second = vi.mocked(attachAgentRun).mock.calls[1][0];
	expect(first.activeSessionRef).not.toBe(second.activeSessionRef);
	first.onStream({ sessionId: "first", chunk: "First" } as Parameters<
		typeof first.onStream
	>[0]);
	first.onStream({ sessionId: "first", chunk: " result" } as Parameters<
		typeof first.onStream
	>[0]);
	first.onCompleted({ sessionId: "first", content: "" } as Parameters<
		typeof first.onCompleted
	>[0]);
	first.onSettled?.();
	expect(h.readCards().find((card) => card.record.id === id)).toMatchObject({
		streaming: false,
		record: { result: "First result" },
	});
	expect(h.readCards().find((card) => card.record.id !== id)?.streaming).toBe(
		true,
	);
	h.closeCard(id);
	first.onStream({ sessionId: "first", chunk: "Late" } as Parameters<
		typeof first.onStream
	>[0]);
	expect(
		h.readCards().find((card) => card.record.id === id)?.record.result,
	).toBe("First result");
});

it("bounds closed-card caching while keeping pinned cards", async () => {
	vi.mocked(runTranslate).mockResolvedValue("Translated");
	const h = harness();
	h.select();
	await flush();
	const id = h.readCards()[0].record.id;
	h.pinCard(id, true);
	for (let i = 0; i < 40; i++) {
		h.select({ ...anchor, quote: `Paragraph ${i}` });
		await flush();
	}
	h.dismissUnpinned();
	expect(h.readCards().filter((card) => !card.visible)).toHaveLength(32);
	expect(h.readCards().find((card) => card.record.id === id)?.pinned).toBe(
		true,
	);
});
