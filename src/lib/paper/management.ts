import { open } from "@tauri-apps/plugin-dialog";
import i18n from "@/i18n";
import { type ApiResult, commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { type PaperMetaPatch, paperMetaPatchToWire } from "@/lib/paper/api";
import {
	libraryStore,
	refreshLibrary,
	setEditMetaDraft,
} from "@/lib/paper/library-store";
import type { PaperLibraryRow } from "@/lib/paper/types";
import { preparePdfReplacement } from "@/lib/pdf/highlight/annotation-store";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath, refreshTree } from "@/lib/vault/store";
import { reloadPaperPdf } from "@/lib/workspace/actions";

const pending = new Set<string>();

async function managementCall<T>(
	invoke: () => Promise<ApiResult<T>>,
): Promise<T> {
	return callApi(async () => {
		const result = await invoke();
		const key = (
			[
				"paper_exists",
				"invalid_pdf",
				"pdf_changed",
				"paper_busy",
				"unsaved_changes",
			] as const
		).find((code) => code === result.error?.code);
		if (!result.ok && key) {
			throw new Error(i18n.t(`sidebar:papersLibrary.managementErrors.${key}`));
		}
		return result;
	});
}

export async function createManualPaper(patch: PaperMetaPatch): Promise<void> {
	const vault = getVaultPath();
	const draft = libraryStore.getState().editMetaDraft;
	if (!vault || pending.has(`create:${vault}`)) return;
	pending.add(`create:${vault}`);
	try {
		await managementCall(() =>
			commands.paperCreateManual(vault, paperMetaPatchToWire(patch)),
		);
		if (getVaultPath() === vault) {
			if (libraryStore.getState().editMetaDraft === draft)
				setEditMetaDraft(null);
			await refreshLibrary();
			await refreshTree(vault);
			notifySuccess(i18n.t("sidebar:papersLibrary.paperAdded"));
		}
	} catch (error) {
		notifyError(errorText(error));
	} finally {
		pending.delete(`create:${vault}`);
	}
}

export async function attachLibraryPdf(paper: PaperLibraryRow): Promise<void> {
	const vault = getVaultPath();
	if (!vault || !paper.path) return;
	const key = `${vault}:${paper.path}`;
	if (pending.has(key)) return;
	pending.add(key);
	try {
		const path = await open({
			multiple: false,
			directory: false,
			filters: [{ name: "PDF", extensions: ["pdf"] }],
			title: i18n.t(
				paper.has_pdf
					? "sidebar:papersLibrary.replacePdf"
					: "sidebar:papersLibrary.attachPdf",
			),
		});
		if (typeof path !== "string" || getVaultPath() !== vault) return;
		const finish = paper.has_pdf
			? await preparePdfReplacement(joinVaultPath(vault, paper.path))
			: null;
		let succeeded = false;
		const result = await (async () => {
			try {
				const result = await managementCall(() =>
					commands.paperAttachPdf(
						vault,
						paper.path,
						path,
						paper.has_pdf === true,
					),
				);
				succeeded = true;
				return result;
			} finally {
				finish?.(succeeded);
			}
		})();
		if (getVaultPath() !== vault) return;
		reloadPaperPdf(joinVaultPath(vault, paper.path));
		await refreshLibrary();
		await refreshTree(vault);
		notifySuccess(
			i18n.t(
				result.backupPath
					? "sidebar:papersLibrary.pdfReplaced"
					: "sidebar:papersLibrary.pdfAttached",
			),
		);
	} catch (error) {
		notifyError(errorText(error));
	} finally {
		pending.delete(key);
	}
}
