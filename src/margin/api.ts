import { invoke } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import {
	type ApiResult,
	commands,
	type ReviewDiffResult,
	type ReviewUnitSummary,
} from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { getPlatformOS } from "@/lib/core/tauri";
import { configureReviewBackend } from "@/lib/review/api";
import { type ReviewDoc, reviewStore, setReviewDoc } from "@/lib/review/store";
import { workspaceStore } from "@/lib/workspace/store";

type Base = { head: string; manuscript: string };
const bases = new Map<string, Base>();
const pending = new Map<string, string>();
const key = (root: string, id: string) => {
	const normalized = root.replaceAll("\\", "/");
	return `${getPlatformOS() === "windows" ? normalized.toLowerCase() : normalized}\0${id}`;
};

/** Adopt only after the caller checks that the live editor is still clean. */
export function adoptMarginSnapshot(
	root: string,
	id: string,
	view: ReviewDoc,
): string {
	if (!view.headId || view.manuscript === undefined)
		throw new Error(i18n.t("common:somethingWrong"));
	bases.set(key(root, id), { head: view.headId, manuscript: view.manuscript });
	return view.manuscript;
}

export async function execute(
	root: string,
	id: string,
	request: Record<string, unknown>,
) {
	const fingerprint = JSON.stringify([root, id, request]);
	const commandId = pending.get(fingerprint) ?? crypto.randomUUID();
	pending.set(fingerprint, commandId);
	try {
		const result = await invoke<ApiResult<ReviewDoc>>("margin_command", {
			vaultPath: root,
			reviewId: id,
			commandId,
			request,
		});
		// A domain rejection is definitive; a lost IPC acknowledgement is not.
		pending.delete(fingerprint);
		if (
			request.kind === "save" &&
			result.ok &&
			result.data?.acknowledgedHead !== result.data?.headId
		) {
			return {
				status: "ok" as const,
				data: {
					ok: false,
					data: null,
					error: {
						code: "manuscript_changed",
						message: i18n.t("margin:conflict"),
					},
				},
			};
		}
		if (
			result.ok &&
			result.data?.headId &&
			result.data.manuscript !== undefined &&
			["save", "decide"].includes(String(request.kind))
		) {
			bases.set(key(root, id), {
				head: result.data.headId,
				manuscript: result.data.manuscript,
			});
		}
		return { status: "ok" as const, data: result };
	} catch (error) {
		return { status: "error" as const, error: String(error) };
	}
}

export async function query<T>(command: string, args: Record<string, unknown>) {
	try {
		return {
			status: "ok" as const,
			data: await invoke<ApiResult<T>>(command, args),
		};
	} catch (error) {
		return { status: "error" as const, error: String(error) };
	}
}

export async function readMarginManuscript(path: string): Promise<string> {
	const normalized = path.replaceAll("\\", "/");
	const marker = "/.margin/documents/";
	const at = normalized.lastIndexOf(marker);
	if (at < 0) throw new Error(i18n.t("common:somethingWrong"));
	const root = normalized.slice(0, at);
	const id = normalized.slice(at + marker.length).split("/")[0];
	const view = await callApiResult(() =>
		query<ReviewDoc>("margin_open", { vaultPath: root, reviewId: id }),
	);
	// A read started while clean may finish after the user began typing. Do not
	// advance that editor's CAS base merely because a newer snapshot was read.
	if (
		workspaceStore
			.getState()
			.tabs.some(
				(tab) => tab.markdownDirty && key(tab.path, "") === key(path, ""),
			)
	) {
		if (view.manuscript === undefined)
			throw new Error(i18n.t("common:somethingWrong"));
		return view.manuscript;
	}
	return adoptMarginSnapshot(root, id, view);
}

export function installMarginReviewApi() {
	bases.clear();
	pending.clear();
	const stamp = (id: string) => reviewStore.getState().docs[id]?.stamp;
	configureReviewBackend(
		{
			...commands,
			reviewCreate: (vaultPath, title) =>
				query<ReviewUnitSummary>("margin_create", { vaultPath, title }),
			reviewImport: (vaultPath, filePaths) =>
				query<ReviewUnitSummary[]>("margin_import", { vaultPath, filePaths }),
			reviewList: (vaultPath) =>
				query<ReviewUnitSummary[]>("margin_list", { vaultPath }),
			reviewOpen: (vaultPath, reviewId) =>
				query<ReviewDoc>("margin_open", { vaultPath, reviewId }),
			reviewStateStamp: (vaultPath, reviewId) =>
				query<string>("margin_stamp", { vaultPath, reviewId }),
			reviewDiff: (vaultPath, reviewId) =>
				query<ReviewDiffResult>("margin_diff", { vaultPath, reviewId }),
			reviewExport: (vaultPath, reviewId, destDir) =>
				query<string>("margin_export", { vaultPath, reviewId, destDir }),
			reviewParsePdf: (vaultPath, reviewId) =>
				query<ReviewDoc>("margin_parse_pdf", { vaultPath, reviewId }),
			reviewSaveManuscript: (root, id, markdown, lastSaved, anchors) =>
				execute(root, id, {
					kind: "save",
					expectedHead: bases.get(key(root, id))?.head,
					lastSaved,
					markdown,
					anchors,
				}),
			reviewApplyChange: (
				root,
				id,
				nextBaseline,
				nextManuscript,
				reason,
				expectedStamp,
			) =>
				execute(root, id, {
					kind: "decide",
					expectedStamp: expectedStamp ?? stamp(id),
					nextBaseline,
					nextManuscript,
					reason,
				}),
			reviewCheckpoint: (root, id) =>
				execute(root, id, {
					kind: "decide",
					expectedStamp: stamp(id),
					nextBaseline: reviewStore.getState().docs[id]?.manuscript,
					reason: "accept-all",
				}),
			reviewRename: async (root, id, title) => {
				const result = await execute(root, id, {
					kind: "rename",
					expectedStamp: stamp(id),
					title,
				});
				if (result.status === "error") return result;
				if (!result.data.ok)
					return {
						status: "ok" as const,
						data: { ok: false, data: null, error: result.data.error },
					};
				if (result.data.data) {
					const held = reviewStore.getState().docs[id];
					if ((held?.sequence ?? 0) <= (result.data.data.sequence ?? 0))
						setReviewDoc(id, result.data.data);
				}
				return query<ReviewUnitSummary[]>("margin_list", {
					vaultPath: root,
				}).then((list) => {
					if (list.status === "error") return list;
					if (!list.data.ok)
						return {
							status: "ok" as const,
							data: { ok: false, data: null, error: list.data.error },
						};
					return {
						status: "ok" as const,
						data: {
							ok: true,
							data: list.data.data?.find((unit) => unit.id === id) ?? null,
							error: null,
						},
					};
				});
			},
			reviewCommentAdd: (root, id, input) =>
				execute(root, id, {
					kind: "comment-add",
					expectedHead: bases.get(key(root, id))?.head,
					input,
				}),
			reviewCommentUpdate: (
				root,
				id,
				commentId,
				action,
				body,
				expectedUpdatedAt,
				replyId,
			) =>
				execute(root, id, {
					kind: "comment-update",
					commentId,
					action,
					body,
					expectedUpdatedAt,
					replyId,
				}),
			reviewRecordEdit: (root, id) => execute(root, id, { kind: "observe" }),
		},
		readMarginManuscript,
	);
}
