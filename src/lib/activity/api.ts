import {
	commands,
	type UsageEvent_Serialize,
	type UsageKindCount,
	type UsageRecord,
} from "@/lib/core/bindings";
import { callApi, callApiResult } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";

/** Wire shapes from the generated bindings (usage.sqlite rows). */
export type ActivityRecord = UsageRecord;
export type UsageEvent = UsageEvent_Serialize;
export type { UsageKindCount };

export async function recordActivityEvents(
	events: ActivityRecord[],
): Promise<number> {
	if (!isTauri() || events.length === 0) return 0;
	return callApiResult(() => commands.activityRecordEvents({ events }), {
		fallback: "activity_record_events failed",
	});
}

export async function listUsageEvents(opts?: {
	vault?: string;
	kind?: string;
	path?: string;
	since?: string;
	limit?: number;
}): Promise<UsageEvent[]> {
	if (!isTauri()) return [];
	return callApi(() => commands.usageList(opts ?? {}), {
		fallback: "usage_list failed",
	});
}

export async function summarizeUsage(opts?: {
	vault?: string;
	since?: string;
}): Promise<UsageKindCount[]> {
	if (!isTauri()) return [];
	return callApi(() => commands.usageSummary(opts ?? {}), {
		fallback: "usage_summary failed",
	});
}

export async function clearUsage(vault?: string): Promise<number> {
	if (!isTauri()) return 0;
	return callApi(() => commands.usageClear({ vault: vault ?? null }), {
		fallback: "usage_clear failed",
	});
}
