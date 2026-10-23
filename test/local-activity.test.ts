import { afterEach, describe, expect, it, vi } from "vitest";
import {
	backgroundTasksStore,
	cancelBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";

const globalWithWindow = globalThis as typeof globalThis & {
	window?: { setTimeout: typeof setTimeout };
};
globalWithWindow.window = { setTimeout };

type FakeListener = (e: {
	event: string;
	id: number;
	payload: unknown;
}) => void;

const mocks = vi.hoisted(() => {
	type CommandSpy = ReturnType<typeof vi.fn>;
	type FakeListener = (e: {
		event: string;
		id: number;
		payload: unknown;
	}) => void;
	const commandSpies = new Map<string, CommandSpy>();
	const eventBindings = new Map<
		string,
		{ listeners: FakeListener[]; unlistens: CommandSpy[] }
	>();
	const bindingFor = (name: string) => {
		let binding = eventBindings.get(name);
		if (!binding) {
			binding = { listeners: [], unlistens: [] };
			eventBindings.set(name, binding);
		}
		return binding;
	};
	return {
		commandSpies,
		eventBindings,
		commandSpy: (name: string): CommandSpy => {
			let spy = commandSpies.get(name);
			if (!spy) {
				spy = vi.fn(async () => ({
					status: "ok",
					data: { ok: true, data: null },
				}));
				commandSpies.set(name, spy);
			}
			return spy;
		},
		bindingFor,
	};
});

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => false,
}));

vi.mock("@/lib/core/ipc", () => ({
	callApi: vi.fn(async () => undefined),
	callApiResult: vi.fn(
		async (
			fn: () => Promise<{
				status: string;
				error?: string;
				data: { ok: boolean; data: unknown };
			}>,
		) => {
			const res = await fn();
			if (res.status === "error") throw new Error(res.error ?? "ipc error");
			if (!res.data.ok) throw new Error("host error");
			return res.data.data;
		},
	),
	callResult: vi.fn(async () => undefined),
}));

vi.mock("@/lib/core/bindings", () => ({
	commands: new Proxy({} as Record<string, unknown>, {
		get: (_target, prop) =>
			typeof prop === "string" ? mocks.commandSpy(prop) : undefined,
	}),
	events: new Proxy({} as Record<string, unknown>, {
		get: (_target, prop) => {
			if (typeof prop !== "string") return undefined;
			const binding = mocks.bindingFor(prop);
			return {
				listen: (cb: FakeListener) => {
					const unlisten = vi.fn(() => {
						const idx = binding.listeners.indexOf(cb);
						if (idx >= 0) binding.listeners.splice(idx, 1);
					});
					binding.listeners.push(cb);
					binding.unlistens.push(unlisten);
					return Promise.resolve(unlisten);
				},
			};
		},
	}),
}));

import { runLocalActivity } from "@/lib/core/tasks";

function row(id: string) {
	return backgroundTasksStore.getState().tasks.find((task) => task.id === id);
}

describe("runLocalActivity facade", () => {
	afterEach(() => {
		backgroundTasksStore.setState({ tasks: [], expanded: false });
	});

	it("runs the activity and completes its panel row", async () => {
		let taskId = "";
		const result = await runLocalActivity(
			{ kind: "paperRead", title: "read", detail: "papers/x" },
			async ({ setProgress, setDetail }) => {
				setDetail("working");
				setProgress(50);
				return 42;
			},
			{ onTaskId: (id) => (taskId = id) },
		);

		expect(result).toBe(42);
		expect(row(taskId)).toMatchObject({
			kind: "paperRead",
			title: "read",
			status: "completed",
			progress: 100,
		});
	});

	it("survives panel cancellation like the legacy runner", async () => {
		let taskId = "";
		const run = runLocalActivity(
			{ kind: "zoteroMigrate", title: "migrate" },
			({ signal }) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new Error("AbortError")),
					);
				}),
			{ onTaskId: (id) => (taskId = id) },
		);
		cancelBackgroundTask(taskId);

		await expect(run).rejects.toSatisfy(isBackgroundTaskCancelledError);
		expect(row(taskId)?.status).toBe("cancelled");
	});

	it("fails the row and rethrows when the activity throws", async () => {
		let taskId = "";
		const run = runLocalActivity(
			{ kind: "layoutRun", title: "boom" },
			async () => {
				throw new Error("nope");
			},
			{ onTaskId: (id) => (taskId = id) },
		);

		await expect(run).rejects.toThrow("nope");
		expect(row(taskId)).toMatchObject({ status: "failed", error: "nope" });
	});
});
