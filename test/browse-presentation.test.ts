import { describe, expect, it, vi } from "vitest";
import { createBrowsePresentation } from "@/lib/browse/presentation";

const rect = { x: 20, y: 60, width: 800, height: 600 };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function setup(
	capture: () => Promise<string>,
	show = async (_source: string) => {},
) {
	const order: string[] = [];
	const deps = {
		capture: vi.fn(capture),
		showFrame: vi.fn(async (source: string) => {
			await show(source);
			order.push("frame");
		}),
		clearFrame: vi.fn(() => {
			order.push("clear");
		}),
		setBounds: vi.fn(async (_rect, visible: boolean) => {
			order.push(visible ? "show" : "hide");
		}),
		onError: vi.fn(),
	};
	return { controller: createBrowsePresentation(deps), deps, order };
}

describe("native browse overlay handoff", () => {
	it("hides an inactive tab immediately without waiting for a slow capture", async () => {
		const capture = deferred<string>();
		const { controller, deps } = setup(() => capture.promise);
		controller.update({ rect, visible: true, covered: true });
		controller.update({ rect, visible: false, covered: false });
		expect(deps.setBounds).toHaveBeenCalledExactlyOnceWith(rect, false);
		capture.resolve("stale-frame");
		await vi.waitFor(() => expect(deps.setBounds).toHaveBeenCalledTimes(2));
		expect(deps.showFrame).not.toHaveBeenCalled();
		controller.update({ rect, visible: true, covered: false });
		await vi.waitFor(() =>
			expect(deps.setBounds).toHaveBeenLastCalledWith(rect, true),
		);
	});
	it("does not restart a pending capture for every resize during a drag", async () => {
		const capture = deferred<string>();
		const { controller, deps } = setup(() => capture.promise);
		controller.update({ rect, visible: true, covered: true });
		const resized = { ...rect, width: 600 };
		controller.update({ rect: resized, visible: true, covered: true });
		capture.resolve("frame");
		await vi.waitFor(() =>
			expect(deps.setBounds).toHaveBeenCalledExactlyOnceWith(resized, false),
		);
		expect(deps.capture).toHaveBeenCalledOnce();
	});
	it("retries a failed restore without discarding the handoff frame", async () => {
		const { controller, deps, order } = setup(async () => "frame");
		controller.update({ rect, visible: true, covered: true });
		await vi.waitFor(() => expect(order).toEqual(["frame", "hide"]));
		deps.setBounds.mockRejectedValueOnce(new Error("temporary IPC failure"));
		controller.update({ rect, visible: true, covered: false });
		await vi.waitFor(() => expect(deps.onError).toHaveBeenCalledOnce());
		expect(deps.clearFrame).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(order.slice(-2)).toEqual(["show", "clear"]));
		expect(deps.setBounds).toHaveBeenCalledTimes(3);
		controller.dispose(rect);
	});
	it("paints before hiding, reuses the frame across overlapping overlays, then restores live content first", async () => {
		const capture = deferred<string>();
		const { controller, deps, order } = setup(() => capture.promise);
		controller.update({ rect, visible: true, covered: true });
		expect(deps.setBounds).not.toHaveBeenCalled();
		capture.resolve("frame-data");
		await vi.waitFor(() => expect(order).toEqual(["frame", "hide"]));
		controller.update({
			rect: { ...rect, width: 700 },
			visible: true,
			covered: true,
		});
		await vi.waitFor(() => expect(deps.setBounds).toHaveBeenCalledTimes(2));
		expect(deps.capture).toHaveBeenCalledOnce();
		controller.update({ rect, visible: true, covered: false });
		await vi.waitFor(() => expect(order.slice(-2)).toEqual(["show", "clear"]));
	});

	it("discards a slow capture when the menu has already closed", async () => {
		const capture = deferred<string>();
		const { controller, deps } = setup(() => capture.promise);
		controller.update({ rect, visible: true, covered: true });
		controller.update({ rect, visible: true, covered: false });
		capture.resolve("stale-frame");
		await vi.waitFor(() =>
			expect(deps.setBounds).toHaveBeenCalledWith(rect, true),
		);
		expect(deps.showFrame).not.toHaveBeenCalled();
		expect(deps.setBounds).not.toHaveBeenCalledWith(rect, false);
	});

	it("does not resurrect a disposed view when image decoding finishes late", async () => {
		const paint = deferred<void>();
		const { controller, deps, order } = setup(
			async () => "frame",
			() => paint.promise,
		);
		controller.update({ rect, visible: true, covered: true });
		await vi.waitFor(() => expect(deps.showFrame).toHaveBeenCalledOnce());
		controller.dispose(rect);
		paint.resolve();
		await vi.waitFor(() => expect(order.slice(-2)).toEqual(["frame", "clear"]));
		expect(deps.setBounds).toHaveBeenCalledExactlyOnceWith(rect, false);
		controller.update({ rect, visible: true, covered: false });
		expect(deps.setBounds).toHaveBeenCalledOnce();
	});

	it("reports capture failure once per overlay instead of retrying every frame, and can recover", async () => {
		const { controller, deps } = setup(async () => {
			throw new Error("capture failed");
		});
		controller.update({ rect, visible: true, covered: true });
		await vi.waitFor(() => expect(deps.onError).toHaveBeenCalledOnce());
		controller.update({
			rect: { ...rect, width: 700 },
			visible: true,
			covered: true,
		});
		await vi.waitFor(() => expect(deps.setBounds).toHaveBeenCalledTimes(2));
		expect(deps.capture).toHaveBeenCalledOnce();
		controller.update({ rect, visible: true, covered: false });
		await vi.waitFor(() =>
			expect(deps.setBounds).toHaveBeenCalledWith(rect, true),
		);
		deps.capture.mockResolvedValue("new-frame");
		controller.update({ rect, visible: true, covered: true });
		await vi.waitFor(() =>
			expect(deps.showFrame).toHaveBeenCalledWith("new-frame"),
		);
	});
});
