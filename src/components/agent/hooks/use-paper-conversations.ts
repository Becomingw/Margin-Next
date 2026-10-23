import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { AgentHistory } from "@/components/agent/hooks/use-agent-history";
import type { AgentPanelRefs } from "@/components/agent/hooks/use-agent-panel-context";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import {
	conversationScope,
	rememberHistoryScopes,
	restoreHistoryScope,
	sessionScope,
} from "@/lib/agent/conversation-history";
import {
	conversationForPaper,
	readPaperConversation,
	rememberPaperConversation,
} from "@/lib/agent/paper-conversations";

type Options = {
	vaultPath: string | null;
	paperPath: string | null;
	scopeKey?: string;
	selectedAgentId: string | null;
	setSelectedAgentId: (id: string) => void;
	historyReady: boolean;
	openHistorySession: AgentHistory["openHistorySession"];
	activateComposerSession: (id: string) => void;
	restoreSavedComposerSession: (previousId: string, nextId: string) => void;
	setSubmitting: (value: boolean) => void;
	clearTransientUi: () => void;
	refs: Pick<
		AgentPanelRefs,
		| "activeTabRef"
		| "activeConversationRef"
		| "historyHydrationGenRef"
		| "sessionContextGenRef"
		| "submissionGenRef"
		| "submittingRef"
		| "pendingSubmissionSessionIdRef"
	>;
};

function storage() {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/** Switch the displayed conversation, never delete another paper's transcript. */
export function usePaperConversations(options: Options) {
	const {
		vaultPath,
		paperPath,
		scopeKey = conversationScope(paperPath, null),
		selectedAgentId,
		setSelectedAgentId,
		historyReady,
		activateComposerSession,
		restoreSavedComposerSession,
		setSubmitting,
		refs,
	} = options;
	const scope = JSON.stringify([vaultPath, scopeKey]);
	const previousScope = useRef<string | null>(null);
	const pending = useRef<ReturnType<typeof conversationForPaper>>(null);
	const previousComposerId = useRef<string | null>(null);
	const draftAgent = useRef<string | null>(null);
	const latest = useRef(options);
	latest.current = options;
	const remembered = useRef(new Map<string, string>());

	useLayoutEffect(() => {
		if (previousScope.current !== scope) {
			previousScope.current = scope;
			const state = agentSessionStore.getState();
			const pointer = vaultPath
				? readPaperConversation(storage(), vaultPath, paperPath, scopeKey)
				: null;
			pending.current = conversationForPaper(
				pointer,
				paperPath,
				state.sessions,
				scopeKey,
			);
			if (pending.current && vaultPath)
				pending.current = restoreHistoryScope(
					storage(),
					vaultPath,
					pending.current,
				);
			if (pending.current && sessionScope(pending.current) !== scopeKey)
				pending.current = null;
			previousComposerId.current = pointer?.id ?? null;
			draftAgent.current = pointer?.id === "draft" ? pointer.agentId : null;
			refs.historyHydrationGenRef.current++;
			refs.sessionContextGenRef.current++;
			refs.submissionGenRef.current++;
			refs.submittingRef.current = false;
			refs.pendingSubmissionSessionIdRef.current = null;
			refs.activeTabRef.current = "draft";
			refs.activeConversationRef.current = null;
			setSubmitting(false);
			state.setSubmitting(false);
			state.startDraft();
			activateComposerSession("draft");
			latest.current.clearTransientUi();
		}
		const target = pending.current;
		if (!target) {
			if (draftAgent.current && draftAgent.current !== selectedAgentId)
				setSelectedAgentId(draftAgent.current);
			else draftAgent.current = null;
			return;
		}
		if (target.agentId !== selectedAgentId) {
			setSelectedAgentId(target.agentId);
			agentSessionStore.getState().setHydratingSessionId(target.id);
			return;
		}
		if (!target.lines.length && !historyReady) {
			agentSessionStore.getState().setHydratingSessionId(target.id);
			return;
		}
		const fresh =
			conversationForPaper(
				target,
				paperPath,
				agentSessionStore.getState().sessions,
				scopeKey,
			) ?? target;
		pending.current = null;
		latest.current.openHistorySession(fresh, { preserveQueue: true });
		if (previousComposerId.current)
			restoreSavedComposerSession(previousComposerId.current, fresh.id);
	}, [
		scope,
		vaultPath,
		paperPath,
		scopeKey,
		selectedAgentId,
		setSelectedAgentId,
		historyReady,
		activateComposerSession,
		restoreSavedComposerSession,
		setSubmitting,
		refs,
	]);

	useEffect(() => {
		if (!vaultPath) return;
		let scopeFingerprint = "";
		const remember = (
			paper: string | null,
			pointer: Parameters<typeof rememberPaperConversation>[3],
			ownerScope = scopeKey,
		) => {
			const key = JSON.stringify([vaultPath, ownerScope]);
			const value = JSON.stringify(pointer);
			if (remembered.current.get(key) === value) return;
			remembered.current.set(key, value);
			rememberPaperConversation(
				storage(),
				vaultPath,
				paper,
				pointer,
				ownerScope,
			);
		};
		const sync = () => {
			if (latest.current.vaultPath !== vaultPath) return;
			const state = agentSessionStore.getState();
			const fingerprint = JSON.stringify(
				state.sessions.map((session) => [
					session.agentId,
					session.id,
					session.providerSessionId,
					sessionScope(session),
				]),
			);
			if (fingerprint !== scopeFingerprint) {
				scopeFingerprint = fingerprint;
				rememberHistoryScopes(storage(), vaultPath, state.sessions);
			}
			// Completion may arrive after switching away. Refresh the saved provider
			// id only if this is still that paper's chosen conversation.
			for (const session of state.sessions) {
				if (!sessionScope(session) || !session.providerSessionId) continue;
				const pointer = readPaperConversation(
					storage(),
					vaultPath,
					session.subjectPaperPath ?? null,
					sessionScope(session),
				);
				if (
					pointer &&
					pointer.agentId === session.agentId &&
					(pointer.id === session.id ||
						pointer.providerSessionId === session.providerSessionId)
				) {
					remember(
						session.subjectPaperPath ?? null,
						{
							id: session.id,
							agentId: session.agentId,
							providerSessionId: session.providerSessionId,
							title: session.title,
						},
						sessionScope(session),
					);
				}
			}
			if (
				pending.current ||
				draftAgent.current ||
				previousScope.current !== scope
			)
				return;
			if (state.activeTabId === "draft") {
				const agentId = selectedAgentId;
				remember(paperPath, agentId ? { id: "draft", agentId } : null);
				return;
			}
			const active = state.sessions.find(
				(session) => session.id === state.activeTabId,
			);
			if (
				!active ||
				(sessionScope(active) !== undefined &&
					sessionScope(active) !== scopeKey)
			)
				return;
			remember(paperPath, {
				id: active.id,
				agentId: active.agentId,
				providerSessionId: active.providerSessionId,
				title: active.title,
			});
		};
		sync();
		return agentSessionStore.subscribe(sync);
	}, [scope, scopeKey, vaultPath, paperPath, selectedAgentId]);

	return useCallback(() => {
		pending.current = null;
		draftAgent.current = null;
		if (vaultPath) {
			const pointer = selectedAgentId
				? { id: "draft", agentId: selectedAgentId }
				: null;
			rememberPaperConversation(
				storage(),
				vaultPath,
				paperPath,
				pointer,
				scopeKey,
			);
			remembered.current.set(scope, JSON.stringify(pointer));
		}
	}, [vaultPath, paperPath, scope, scopeKey, selectedAgentId]);
}
