import i18n from "@/i18n";
import { type ApiResult, commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";

async function codeCall<T>(invoke: () => Promise<ApiResult<T>>): Promise<T> {
	return callApi(async () => {
		const result = await invoke();
		const key = (
			[
				"code_invalid_url",
				"code_download_failed",
				"code_too_large",
				"code_invalid_archive",
				"code_exists",
				"code_invalid_path",
				"code_not_text",
				"paper_not_found",
				"paper_busy",
			] as const
		).find((code) => code === result.error?.code);
		if (!result.ok && key)
			throw new Error(i18n.t(`sidebar:paperCode.errors.${key}`));
		return result;
	});
}

export const inspectPaperCode = (vault: string, path: string) =>
	codeCall(() => commands.paperCodeInspect(vault, path));
export const importPaperCode = (vault: string, path: string, url: string) =>
	codeCall(() => commands.paperCodeImport(vault, path, url));
export const listCodeFiles = (vault: string, path: string, id: string) =>
	codeCall(() => commands.paperCodeFiles(vault, path, id));
export const readCodeFile = (
	vault: string,
	path: string,
	id: string,
	file: string,
) => codeCall(() => commands.paperCodeRead(vault, path, id, file));
