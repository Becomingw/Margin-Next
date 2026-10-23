import {
	type BridgeDevice as BridgeDeviceWire,
	type BridgeStatus as BridgeStatusWire,
	commands,
	events,
} from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";

export type BridgeStatus = {
	enabled: boolean;
	online: boolean;
	serverId?: string;
	relayEndpoint: string;
	hostName?: string;
	vaultPath?: string;
	activeConnections: number;
	pendingPairings: PairingRequest[];
	lastError?: string;
};

export type BridgeOfferResult = { url: string };

export type PairingRequest = {
	requestId: string;
	deviceId: string;
	deviceName: string;
	verificationCode: string;
};

export type BridgeDevice = {
	deviceId: string;
	name: string;
	pairedAt: string;
	lastSeenAt?: string;
	revoked: boolean;
};

/** Fold generated `null` optionals into the local absent-optional shape. */
function statusFromWire(status: BridgeStatusWire): BridgeStatus {
	return {
		enabled: status.enabled,
		online: status.online,
		serverId: status.serverId ?? undefined,
		relayEndpoint: status.relayEndpoint,
		hostName: status.hostName ?? undefined,
		vaultPath: status.vaultPath ?? undefined,
		activeConnections: status.activeConnections,
		pendingPairings: status.pendingPairings,
		lastError: status.lastError ?? undefined,
	};
}

function deviceFromWire(device: BridgeDeviceWire): BridgeDevice {
	return {
		deviceId: device.deviceId,
		name: device.name,
		pairedAt: device.pairedAt,
		lastSeenAt: device.lastSeenAt ?? undefined,
		revoked: device.revoked ?? false,
	};
}

export async function bridgeStart(args: {
	vaultPath: string;
	hostName: string;
	relayEndpoint?: string;
}): Promise<BridgeStatus> {
	return statusFromWire(await callApi(() => commands.bridgeStart(args)));
}

export async function bridgeStop(): Promise<void> {
	await callApi(() => commands.bridgeStop());
}

export async function bridgeHostStatus(): Promise<BridgeStatus> {
	return statusFromWire(await callApi(() => commands.bridgeStatus()));
}

export function bridgeOffer(): Promise<BridgeOfferResult> {
	return callApi(() => commands.bridgeOffer());
}

export async function bridgeDevices(): Promise<BridgeDevice[]> {
	const devices = await callApi(() => commands.bridgeDevices());
	return devices.map(deviceFromWire);
}

export function bridgeRespondToPairing(
	requestId: string,
	allowed: boolean,
): Promise<boolean> {
	return callApi(() => commands.bridgePairRespond(requestId, allowed));
}

export function bridgeRevokeDevice(deviceId: string): Promise<boolean> {
	return callApi(() => commands.bridgeRevokeDevice(deviceId));
}

export function listenPairingRequest(
	handler: (request: PairingRequest) => void,
): Promise<() => void> {
	return events.bridgePairRequest.listen((event) => handler(event.payload));
}

export function listenHostStatus(
	handler: (online: boolean) => void,
): Promise<() => void> {
	return events.bridgeHostStatus.listen((event) => handler(event.payload));
}
