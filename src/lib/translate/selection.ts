/**
 * Translate one web-page selection, streaming the result: through the
 * configured agent (`runOnce`, reusing a translate session per page) or a free
 * MT provider. Shared by web papers (the iframe toolbar) and Browse views (the
 * in-page card); callers own the display.
 */

import i18n from "@/i18n";
import {
	attachAgentRun,
	disposeAgentRun,
	listAgents,
	runOnce,
} from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	evictAgentTranslateSessionId,
	getAgentTranslateSessionId,
	setAgentTranslateSessionId,
} from "@/lib/pdf/translate/agent-session-cache";
import { loadSettings } from "@/lib/settings";
import { getVaultPath } from "@/lib/vault/store";
import {
	buildTranslatePrompt,
	displayTranslateError,
	prepareTranslateTask,
	resolveTranslateAgent,
	runTranslate,
} from "./index";

export type SelectionTranslation = {
	/** Stop streaming; no callback fires afterwards. */
	cancel: () => void;
};

export function translateWebSelection({
	text,
	sourceKey,
	onText,
	onError,
	onSettled,
}: {
	text: string;
	/** Page URL: the agent translate session is cached per source. */
	sourceKey: string;
	/** The translation so far (full text each time). */
	onText: (text: string) => void;
	onError: (message: string) => void;
	/** Streaming ended (done, failed or cancelled). */
	onSettled: () => void;
}): SelectionTranslation {
	const refs = {
		disposedRef: { current: false },
		unsubsRef: { current: null as (() => void)[] | null },
		sessionRef: { current: null as string | null },
		activeSessionRef: { current: null as string | null },
	};
	let settled = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		onSettled();
	};
	const live = () => !refs.disposedRef.current;
	const fail = (message: string) => {
		if (!live()) return;
		notifyError(message);
		onError(message);
		settle();
	};

	const { providerId, targetLangName } = prepareTranslateTask({
		text,
		context: { surface: "web-selection" },
	});

	if (providerId === "agent") {
		void (async () => {
			try {
				const registry = await listAgents().catch(() => null);
				const { agentId, modelId } = resolveTranslateAgent(
					loadSettings().translate,
					registry,
				);
				if (!agentId) {
					fail(i18n.t("viewer:selection.translateNoAgent"));
					return;
				}
				const accepted = await runOnce({
					prompt: buildTranslatePrompt({
						text,
						targetLangName,
						surface: "web-selection",
					}),
					agentId,
					modelId,
					sessionId:
						getAgentTranslateSessionId(sourceKey, agentId, modelId) ??
						undefined,
					vaultPath: getVaultPath() ?? undefined,
					workflow: "translate",
					permissionMode: "auto",
					hideFromChatHistory: true,
				});
				let result = "";
				await attachAgentRun({
					accepted,
					...refs,
					onStream: (ev) => {
						result += ev.chunk;
						if (live()) onText(result);
					},
					onCompleted: (ev) => {
						if (!live()) return;
						onText((ev.content || result).trim());
						if (ev.providerSessionId && ev.stopReason !== "cancelled") {
							setAgentTranslateSessionId(
								sourceKey,
								agentId,
								modelId,
								ev.providerSessionId,
							);
						}
					},
					onFailed: (ev) => {
						evictAgentTranslateSessionId(sourceKey, agentId, modelId);
						fail(ev.error || i18n.t("viewer:pdfAsk.agentFailed"));
					},
					onSettled: settle,
				});
			} catch (e) {
				fail(errorText(e));
			}
		})();
	} else {
		void (async () => {
			try {
				const result = await runTranslate(
					{ text, context: { surface: "web-selection" } },
					{ providerId },
				);
				if (live()) onText(result.trim());
				settle();
			} catch (e) {
				fail(displayTranslateError(errorText(e)));
			}
		})();
	}

	return {
		cancel: () => {
			settled = true;
			disposeAgentRun(refs);
		},
	};
}
