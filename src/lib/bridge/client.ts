import { type InvokeArgs, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ApiResult } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";

/**
 * iOS bridge **client** commands (`client_commands.rs`) are mobile-gated and
 * not part of the desktop specta bindings, so this file keeps the string
 * invoke path with the same `ApiResult` envelope semantics as the typed
 * helpers in `@/lib/core/ipc`.
 */
async function invokeBridgeApi<T>(
	cmd: string,
	args?: InvokeArgs,
	fallback?: string,
): Promise<T> {
	if (!isTauri()) {
		throw new Error(
			fallback ?? `Command ${cmd} requires the Tauri desktop app.`,
		);
	}
	const res = await invoke<ApiResult<T>>(cmd, args);
	if (!res.ok) {
		const body = res.error as {
			code: string;
			message: string;
			details?: unknown;
		} | null;
		const error = new Error(
			body?.message ?? fallback ?? `Command ${cmd} failed`,
		) as Error & { details?: unknown };
		error.details = body?.details;
		throw error;
	}
	return res.data as T;
}

export type BridgeClientStatus = {
	connected: boolean;
	paired: boolean;
	serverId?: string;
	hostName?: string;
	relayEndpoint?: string;
	vaultName?: string;
	lastError?: string;
};

export type PairPendingEvent = {
	requestId: string;
	verificationCode: string;
};

export async function bridgeConnect(args: {
	offerUrl: string;
	deviceName: string;
}): Promise<BridgeClientStatus> {
	return invokeBridgeApi<BridgeClientStatus>(
		"bridge_connect",
		{ args },
		"Could not connect to this desktop",
	);
}

export async function bridgeDisconnect(): Promise<void> {
	await invokeBridgeApi<void>(
		"bridge_disconnect",
		undefined,
		"Could not disconnect from this desktop",
	);
}

export async function bridgeResume(): Promise<BridgeClientStatus> {
	return invokeBridgeApi<BridgeClientStatus>(
		"bridge_resume",
		undefined,
		"Could not resume this desktop connection",
	);
}

export async function bridgeStatus(): Promise<BridgeClientStatus> {
	return invokeBridgeApi<BridgeClientStatus>(
		"bridge_status",
		undefined,
		"Could not read connection status",
	);
}

export async function bridgeRpc<T>(
	method: string,
	params: Record<string, unknown> = {},
): Promise<T> {
	return invokeBridgeApi<T>(
		"bridge_rpc",
		{ method, params },
		`${method} failed`,
	);
}

export async function listenBridgeStatus(
	handler: (status: BridgeClientStatus) => void,
): Promise<() => void> {
	return listen<BridgeClientStatus>("bridge:status", (event) =>
		handler(event.payload),
	);
}

export type BridgeProgressPhase =
	| "relayConnecting"
	| "e2eeHandshake"
	| "pairing"
	| "authenticating"
	| "connected";

export async function listenBridgeProgress(
	handler: (phase: BridgeProgressPhase) => void,
): Promise<() => void> {
	return listen<BridgeProgressPhase>("bridge:progress", (event) =>
		handler(event.payload),
	);
}

export async function listenPairPending(
	handler: (event: PairPendingEvent) => void,
): Promise<() => void> {
	return listen<PairPendingEvent>("bridge:pair-pending", (event) =>
		handler(event.payload),
	);
}

export async function listenBridgeEvent<T>(
	name: string,
	handler: (payload: T) => void,
): Promise<() => void> {
	return listen<T>(`bridge:event:${name}`, (event) => handler(event.payload));
}
