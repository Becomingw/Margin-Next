import { commands } from "@/lib/core/bindings";
import { readVaultFile } from "@/lib/vault/fs";

/** The standalone host supplies a document API; the upstream workbench keeps
 * its existing file-backed implementation. No storage policy in the editor. */
type ReviewApi = Omit<typeof commands, "reviewApplyChange"> & {
	reviewApplyChange: (
		...args: [
			...Parameters<typeof commands.reviewApplyChange>,
			expectedStamp?: string,
		]
	) => ReturnType<typeof commands.reviewApplyChange>;
};
export let reviewApi: ReviewApi = commands;
export let readReviewManuscript = readVaultFile;
export function configureReviewBackend(
	api: ReviewApi,
	read: typeof readVaultFile,
) {
	reviewApi = api;
	readReviewManuscript = read;
}
