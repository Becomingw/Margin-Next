import {
	type ClearAndReparseResult,
	type ClearParseResultsResult,
	commands,
	type ParseResultScope,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";

export type {
	ClearAndReparseResult,
	ClearParseResultsResult,
	ParseResultScope,
};

export async function clearParseResults(
	vaultPath: string,
	scope: ParseResultScope,
): Promise<ClearParseResultsResult> {
	return callApiResult(() => commands.clearParseResults({ vaultPath, scope }), {
		fallback: "Failed to clear parse results",
	});
}

export async function clearAndReparse(
	vaultPath: string,
	scope: ParseResultScope,
): Promise<ClearAndReparseResult> {
	return callApiResult(() => commands.clearAndReparse({ vaultPath, scope }), {
		fallback: "Failed to clear and reparse",
	});
}
