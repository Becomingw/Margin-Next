import i18n from "@/i18n";
import {
	referenceAnchors,
	type SelectionContext,
} from "@/lib/agent/selection-reference";
import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import {
	clearPendingPdfPage,
	setPendingPdfPage,
} from "@/lib/pdf/pending-pdf-page";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";
import { openTab } from "@/lib/workspace/actions";
import { tabIdForPath } from "@/lib/workspace/tabs";
import {
	pdfHandleFor,
	subscribePdfHandles,
} from "@/lib/workspace/viewer/pdf-viewer-registry";

let cancelPendingJump: (() => void) | null = null;

/** Read-only navigation: opening a quotation never creates a PDF mark. */
export function openSelectionReference(
	reference: SelectionContext,
	page?: number,
): void {
	cancelPendingJump?.();
	const source = reference.sourcePath.replace(/\\/g, "/");
	if (/^https?:\/\//i.test(source)) {
		openExternalUrl(source);
		return;
	}
	const vault = getVaultPath();
	if (
		!source ||
		source === "PDF" ||
		(!vault && !source.startsWith(`${VIRTUAL_PATH_PREFIX}`))
	) {
		notifyError(i18n.t("agent:references.unavailable"));
		return;
	}
	const path =
		source.startsWith(`${VIRTUAL_PATH_PREFIX}`) ||
		/^(?:\/|[A-Za-z]:\/)/.test(source)
			? source
			: joinVaultPath(vault ?? "", source);
	if (reference.origin !== "pdf") {
		openTab(path);
		return;
	}
	const anchors = referenceAnchors(reference);
	const anchor =
		anchors.find((item) => item.page === page) ??
		anchors[0] ??
		(reference.page ? { page: reference.page, rects: [] } : null);
	if (!anchor) {
		notifyError(i18n.t("agent:references.unavailable"));
		return;
	}
	const keys = [path, source];
	setPendingPdfPage(keys, anchor.page);
	openTab(path, { preferMode: "pdf", skipDefaultNotes: true });
	const id = tabIdForPath(path);
	let off = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = () => {
		off();
		if (timer) clearTimeout(timer);
		clearPendingPdfPage(keys);
		if (cancelPendingJump === cleanup) cancelPendingJump = null;
	};
	const reveal = () => {
		const handle = pdfHandleFor(id);
		if (!handle?.revealReference) return false;
		handle.revealReference({ ...anchor, id: reference.id });
		cleanup();
		return true;
	};
	cancelPendingJump = cleanup;
	if (!reveal()) {
		off = subscribePdfHandles(reveal);
		timer = setTimeout(() => {
			cleanup();
			notifyError(i18n.t("agent:references.unavailable"));
		}, 10000);
	}
}
