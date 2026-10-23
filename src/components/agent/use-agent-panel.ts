/**
 * Agent panel session/runtime orchestrator: composes the focused sub-hooks
 * (context, config, session runtime, permission surfaces, send, message edit,
 * composer, history) and owns cross-cutting lifecycle — vault switch reset,
 * cross-window session handoff, agent switch, and new conversation.
 * UI lives in sibling components under `src/components/agent/`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentComposer } from "@/components/agent/hooks/use-agent-composer";
import { useAgentConfig } from "@/components/agent/hooks/use-agent-config";
import { useAgentHistory } from "@/components/agent/hooks/use-agent-history";
import { useAgentMessageEdit } from "@/components/agent/hooks/use-agent-message-edit";
import { useAgentPanelContext } from "@/components/agent/hooks/use-agent-panel-context";
import { useAgentPermissionSurfaces } from "@/components/agent/hooks/use-agent-permission-surfaces";
import { useAgentSend } from "@/components/agent/hooks/use-agent-send";
import { useAgentSessionRuntime } from "@/components/agent/hooks/use-agent-session-runtime";
import { usePaperConversations } from "@/components/agent/hooks/use-paper-conversations";
import type { AgentPanelProps } from "@/components/agent/types";
import { useSessionComposerState } from "@/hooks/use-session-composer-state";
import {
	cancelAgentRun,
	ensureCatalogAgent,
	setDefaultAgent,
} from "@/lib/agent";
import { agentChromeStore } from "@/lib/agent/agent-chrome-store";
import {
	agentSessionStore,
	applyAgentSessionHandoffOnce,
	useActiveChatLines,
	useAgentSessionStore,
} from "@/lib/agent/agent-session-store";
import type { ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import {
	type AgentOption,
	buildOptions,
	errorChatLine,
	errorText,
	pendingQuestionFromLines,
	resolveSelected,
} from "@/lib/agent/chat-state";
import { extractSelectionTokens } from "@/lib/agent/composer-inline-tokens";
import {
	composerScopeKey,
	removeAgentComposerState,
} from "@/lib/agent/composer-state";
import { normalizeContextPath } from "@/lib/agent/context-path-icon";
import {
	conversationScope,
	historyStorage,
	MANAGEMENT_SCOPE,
	removeHistorySession,
	sessionScope,
} from "@/lib/agent/conversation-history";
import { removeCachedHistoryTitle } from "@/lib/agent/history-title-cache";
import {
	paperDraftKey,
	readPaperConversation,
	rememberPaperConversation,
} from "@/lib/agent/paper-conversations";
import { referenceContextPaths } from "@/lib/agent/paper-qa";
import { removeReferenceHistory } from "@/lib/agent/reference-history";
import { removeVisualDraft } from "@/lib/agent/visual-context-store";
import { VIRTUAL_PATH_PREFIX } from "@/lib/core/app-identity";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { listenAgentSessionHandoff } from "@/lib/shell/workspace-broadcast";

export type UseAgentPanelArgs = Pick<
	AgentPanelProps,
	| "vaultPath"
	| "selectedPath"
	| "selectedPaperTitle"
	| "vaultMarkdownPaths"
	| "vaultDirectoryPaths"
	| "vaultPaperPaths"
	| "paperMetaByRelPath"
	| "paperTreeLabelMode"
>;

export function useAgentPanel({
	vaultPath,
	selectedPath = null,
	selectedPaperTitle = null,
	vaultMarkdownPaths = [],
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
}: UseAgentPanelArgs) {
	const { t, i18n } = useTranslation("agent");

	const {
		selectedVaultPath,
		directoryPathSet,
		paperPathSet,
		labelForPath,
		mentionLabelsByPath,
		refs,
		resetSessionContext,
	} = useAgentPanelContext({
		vaultPath,
		selectedPath,
		selectedPaperTitle,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		paperMetaByRelPath,
		paperTreeLabelMode,
	});
	const {
		activeConversationRef,
		activeTabRef,
		selectedAgentIdRef,
		switchingRef,
		submittingRef,
		submissionGenRef,
		historyHydrationGenRef,
		knownSessionIdsRef,
		sessionHistoryRef,
		vaultPathRef,
		previousVaultPathRef,
	} = refs;

	// Shared store selectors (single source of truth for the transcript).
	const lines = useActiveChatLines();
	const setLines = useAgentSessionStore((s) => s.setLines);
	const sessionHistory = useAgentSessionStore((s) => s.sessions);
	const setSessionHistory = useAgentSessionStore((s) => s.setSessions);
	const activeTabId = useAgentSessionStore((s) => s.activeTabId);
	const hydratingSessionId = useAgentSessionStore((s) => s.hydratingSessionId);
	const setActiveTabId = useAgentSessionStore((s) => s.setActiveTabId);
	const startDraft = useAgentSessionStore((s) => s.startDraft);
	const setHydratingSessionId = useAgentSessionStore(
		(s) => s.setHydratingSessionId,
	);
	const hydrateAndActivateSession = useAgentSessionStore(
		(s) => s.hydrateAndActivateSession,
	);
	const setStoreSubmitting = useAgentSessionStore((s) => s.setSubmitting);

	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [switching, setSwitching] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const paperPath =
		selectedVaultPath &&
		(paperPathSet.has(normalizeContextPath(selectedVaultPath)) ||
			/\.pdf$/i.test(selectedVaultPath) ||
			selectedVaultPath.startsWith(`${VIRTUAL_PATH_PREFIX}arxiv:`))
			? selectedVaultPath
			: null;
	const scopeKey = conversationScope(
		paperPath,
		selectedVaultPath ?? selectedPath,
	);

	const composerState = useSessionComposerState({
		vaultPath,
		agentId: selectedAgentId,
		sessionId: activeTabId,
		draftKey: paperPath ? paperDraftKey(paperPath) : `draft:${scopeKey}`,
		// Current paper/file is always in context by default (no click-to-add).
		defaultIncludeSelectedFile: true,
	});
	const scopeRef = useRef(scopeKey);
	scopeRef.current = scopeKey;
	const {
		text: composerText,
		mentionedPaths,
		includeSelectedFile,
		activateSession: activateComposerSession,
		completeSubmission: completeComposerSubmission,
		resetSession: resetComposerSession,
		restoreSavedSession: restoreSavedComposerSession,
		setText: setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
		snapshot: snapshotComposerState,
	} = composerState;

	const draftReferences = useMemo(
		() => extractSelectionTokens(composerText),
		[composerText],
	);
	const boundPaperPaths = sessionHistory.find(
		(session) => session.id === activeTabId,
	)?.qaPaperPaths;
	const contextPaths = useMemo(() => {
		const paths = [
			...(includeSelectedFile && selectedVaultPath ? [selectedVaultPath] : []),
			...mentionedPaths,
		];
		return referenceContextPaths(
			draftReferences,
			paths,
			mentionedPaths,
			includeSelectedFile ? boundPaperPaths : [],
		);
	}, [
		includeSelectedFile,
		mentionedPaths,
		selectedVaultPath,
		draftReferences,
		boundPaperPaths,
	]);

	/** Current paper/file path when included (always-on chip; no dashed + toggle). */
	const currentFilePath = draftReferences.length
		? null
		: includeSelectedFile
			? (boundPaperPaths?.[0] ?? selectedVaultPath)
			: null;

	useEffect(() => {
		sessionHistoryRef.current = sessionHistory;
	}, [sessionHistory, sessionHistoryRef]);

	useEffect(() => {
		vaultPathRef.current = vaultPath;
	}, [vaultPath, vaultPathRef]);

	const {
		registry,
		catalog,
		skills,
		models,
		modelId,
		favoriteIds,
		modelSelectorOpen,
		setModelSelectorOpen,
		warming,
		setAgentListenersReady,
		usage,
		setUsage,
		usageBySession,
		setUsageBySession,
		acpCommandsByAgent,
		setAcpCommandsByAgent,
		collaborationOptions,
		collaborationModeId,
		effortOptions,
		reasoningEffort,
		pickReasoningEffort,
		fastAvailable,
		fastEnabled,
		setFastEnabled,
		applyModelsEvent,
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		refresh,
		selectedModelName,
		groupedModels,
		selectedCollaborationName,
		pickCollaborationMode,
		pickModel,
		toggleFavorite,
	} = useAgentConfig({
		vaultPath,
		selectedAgentId,
		setSelectedAgentId,
		refs,
		t,
		setLines,
	});

	const options = buildOptions(registry, catalog);
	const selected = resolveSelected(options, selectedAgentId, registry);

	// Keep app chrome (title bar, mobile nav, …) in sync with the active agent.
	useEffect(() => {
		if (!selected) return;
		agentChromeStore.setState({
			agentId: selected.id,
			name: selected.name,
			template: selected.template ?? null,
		});
	}, [selected]);

	const activeTabSession = sessionHistory.find(
		(session) => session.id === activeTabId,
	);
	const activeTabIsRunning = activeTabSession?.status === "running";
	const activeUsage = usageBySession[activeTabId] ?? usage;
	const hasRunningSessions = sessionHistory.some(
		(session) => session.status === "running",
	);

	const {
		toolAskUserRequest,
		setToolAskUserRequest,
		applyStreamEvent,
		applyToolEvent,
		applyPlanEvent,
		completeSession,
		failSession,
		phaseBySession,
	} = useAgentSessionRuntime({
		refs,
		t,
		setSessionHistory,
		applyModelsEvent,
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		setUsage,
		setUsageBySession,
		setAcpCommandsByAgent,
		setAgentListenersReady,
	});

	const {
		permissionRequest,
		setPermissionRequest,
		elicitationRequest,
		setElicitationRequest,
		askUserRequest,
		setAskUserRequest,
	} = useAgentPermissionSurfaces({
		activeSessionId: activeTabId,
		toolAskUserRequest,
		setToolAskUserRequest,
	});

	const {
		send,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		clearMessageQueue,
		cancelCurrentRun,
		answerToolAskUser,
	} = useAgentSend({
		skills,
		paperPath,
		conversationScope: scopeKey,
		refs,
		t,
		i18nLanguage: i18n.language,
		vaultPath,
		lines,
		setLines,
		setSessionHistory,
		setActiveTabId,
		activeTabId,
		activeTabIsRunning,
		submitting,
		switching: switching || Boolean(hydratingSessionId),
		setSubmitting,
		setStoreSubmitting,
		setHistoryOpen,
		setSelectedAgentId,
		selected,
		registry,
		refresh,
		modelId,
		collaborationModeId,
		collaborationOptions,
		reasoningEffort,
		fastAvailable,
		fastEnabled,
		acpCommandsByAgent,
		contextPaths,
		selectedVaultPath,
		snapshotComposerState,
		completeComposerSubmission,
		setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
		activateComposerSession,
		applyStreamEvent,
		applyToolEvent,
		applyPlanEvent,
		completeSession,
		failSession,
		setToolAskUserRequest,
	});

	const {
		editingLineId,
		editingText,
		setEditingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		startEditingMessage,
		cancelEditingMessage,
		resendEditedMessage,
	} = useAgentMessageEdit({
		refs,
		activeTabId,
		activeTabIsRunning,
		lines,
		send,
	});

	const {
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setQuickActiveIndex,
		currentFileLabel,
		mentionChipPaths,
		selectionChips,
		visualDrafts,
		removeContextPath,
		selectedSkills,
		showMentionMenu,
		mentionBrowseRoot,
		mentionOptions,
		mentionActiveIndex,
		mentionCandidates,
		leaveMentionFolder,
		enterMentionFolder,
		attachMention,
		showQuickMenu,
		quickOptions,
		quickActiveIndex,
		pickQuickOption,
		removeSkill,
		handleComposerMenuKeyDown,
		handleComposerDragOver,
		handleComposerDrop,
		onComposerTextChangeFromUser,
		composerInputRef,
	} = useAgentComposer({
		selectionPaperPath: paperPath,
		followSelectedFile: !boundPaperPaths?.length,
		refs,
		composer: composerState,
		vaultPath,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		selectedPaperTitle,
		selectedVaultPath,
		paperPathSet,
		labelForPath,
		mentionLabelsByPath,
		contextPaths,
		currentFilePath,
		skills,
		acpCommandsByAgent,
		selectedAgentId,
		lines,
		activeTabIsRunning,
		cancelCurrentRun,
	});

	// Vault switch: cancel running sessions and reset the whole panel context.
	useLayoutEffect(() => {
		if (previousVaultPathRef.current === vaultPath) return;
		previousVaultPathRef.current = vaultPath;
		for (const session of sessionHistoryRef.current) {
			if (session.status === "running") {
				void cancelAgentRun(session.id).catch(() => undefined);
			}
		}
		resetSessionContext();
		submissionGenRef.current += 1;
		submittingRef.current = false;
		setSubmitting(false);
		setLines([]);
		setSessionHistory([]);
		setUsage(null);
		setUsageBySession({});
		setHistoryOpen(false);
		setComposerMenuDismissed(false);
		setMentionActiveIndex(0);
		setQuickActiveIndex(0);
		setActiveTabId("draft");
		setHydratingSessionId(null);
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	}, [
		vaultPath,
		clearMessageQueue,
		setLines,
		setSessionHistory,
		setActiveTabId,
		setHydratingSessionId,
		resetSessionContext,
		setUsage,
		setUsageBySession,
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setQuickActiveIndex,
		previousVaultPathRef,
		activeTabRef,
		submittingRef,
		activeConversationRef,
		submissionGenRef,
		sessionHistoryRef.current,
	]);

	// Cross-window handoff: first snapshot only (retries may arrive later).
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listenAgentSessionHandoff((payload) => {
			const current = agentSessionStore.getState();
			const incomingActive = payload.sessions.find(
				(session) => session.id === payload.activeTabId,
			);
			const followIncoming = incomingActive
				? sessionScope(incomingActive) === scopeRef.current
				: scopeRef.current === MANAGEMENT_SCOPE;
			const mergedSessions = [
				...new Map(
					[...payload.sessions, ...current.sessions].map((session) => [
						session.id,
						session,
					]),
				).values(),
			];
			const applied = applyAgentSessionHandoffOnce({
				sessions: mergedSessions,
				activeTabId: followIncoming ? payload.activeTabId : current.activeTabId,
				draftLines: followIncoming ? payload.draftLines : current.draftLines,
			});
			if (!applied) return;
			knownSessionIdsRef.current = new Set(
				mergedSessions.map((session) => session.id),
			);
			if (!followIncoming) return;
			const agentId =
				payload.selectedAgentId ??
				payload.sessions.find((s) => s.id === payload.activeTabId)?.agentId ??
				payload.sessions[0]?.agentId ??
				null;
			if (agentId) {
				setSelectedAgentId(agentId);
				selectedAgentIdRef.current = agentId;
			}
			const tabId = payload.activeTabId || "draft";
			activeTabRef.current = tabId;
			activeConversationRef.current =
				tabId === "draft" ? null : (incomingActive?.providerSessionId ?? null);
			// Composer scope follows session id; force activate after handoff.
			activateComposerSession(tabId);
		}).then((u) => {
			unlisten = u;
		});
		return () => {
			unlisten?.();
		};
	}, [
		activateComposerSession,
		selectedAgentIdRef,
		knownSessionIdsRef,
		activeTabRef,
		activeConversationRef,
	]);

	const selectAgent = async (opt: AgentOption) => {
		if (
			!isTauri() ||
			switchingRef.current ||
			hasRunningSessions ||
			submittingRef.current
		)
			return;
		if (opt.id && opt.id === selectedAgentId) return;

		switchingRef.current = true;
		setSwitching(true);
		try {
			let agentId = opt.id;
			if (!agentId && opt.templateId) {
				const agent = await ensureCatalogAgent(opt.templateId, true);
				agentId = agent.id;
			} else if (agentId) {
				await setDefaultAgent(agentId);
			} else {
				return;
			}
			resetSessionContext();
			selectedAgentIdRef.current = agentId;
			activeConversationRef.current = null;
			activateComposerSession("draft");
			activeTabRef.current = "draft";
			setActiveTabId("draft");
			setHydratingSessionId(null);
			setLines([]);
			clearMessageQueue();
			setSelectedAgentId(agentId);
			await refresh();
		} catch (e) {
			setLines((p) => [...p, errorChatLine(errorText(e))]);
		} finally {
			switchingRef.current = false;
			setSwitching(false);
		}
	};

	const newConversation = () => {
		if (submittingRef.current) return;
		startPaperDraft();
		historyHydrationGenRef.current += 1;
		startDraft();
		resetComposerSession("draft");
		activeTabRef.current = "draft";
		activeConversationRef.current = null;
		clearMessageQueue();
	};

	const { openHistorySession, historyReady, historyLoading } = useAgentHistory({
		vaultPaperPaths,
		refs,
		t,
		i18nLanguage: i18n.language,
		vaultPath,
		selectedAgentId,
		setSelectedAgentId,
		selected,
		setSessionHistory,
		setLines,
		hydrateAndActivateSession,
		setHydratingSessionId,
		activateComposerSession,
		setHistoryOpen,
		historyOpen,
		clearMessageQueue,
	});
	const startPaperDraft = usePaperConversations({
		vaultPath,
		paperPath,
		scopeKey,
		selectedAgentId,
		setSelectedAgentId,
		historyReady,
		openHistorySession,
		activateComposerSession,
		restoreSavedComposerSession,
		setSubmitting,
		refs,
		clearTransientUi: () => {
			cancelEditingMessage();
			setToolAskUserRequest(null);
			setHistoryOpen(false);
			setComposerMenuDismissed(false);
		},
	});
	const deleteHistorySession = (item: ChatSessionHistoryItem) => {
		if (!vaultPath || submittingRef.current || item.status === "running")
			return;
		const matches = (session: ChatSessionHistoryItem) =>
			session.agentId === item.agentId &&
			(session.id === item.id ||
				Boolean(
					item.providerSessionId &&
						session.providerSessionId === item.providerSessionId,
				));
		const related = agentSessionStore.getState().sessions.filter(matches);
		if (related.some((session) => session.status === "running")) return;
		const storage = historyStorage();
		if (!removeHistorySession(storage, vaultPath, item)) {
			notifyError(t("history.deleteFailed"));
			return;
		}
		if (
			activeTabRef.current === item.id ||
			related.some((session) => session.id === activeTabRef.current)
		)
			newConversation();
		setSessionHistory((sessions) =>
			sessions.filter((session) => !matches(session)),
		);
		const composerScope = composerScopeKey(vaultPath, item.agentId);
		for (const id of [
			...new Set([
				item.id,
				item.providerSessionId,
				...related.map((session) => session.id),
			]),
		].filter((value): value is string => Boolean(value))) {
			removeReferenceHistory(storage, vaultPath, item.agentId, id);
			removeCachedHistoryTitle(item.agentId, id);
			if (storage && composerScope)
				removeAgentComposerState(storage, composerScope, id);
		}
		const owner = sessionScope(item) ?? scopeKey;
		const paper = owner.startsWith("paper:") ? owner.slice(6) : null;
		const pointer = readPaperConversation(storage, vaultPath, paper, owner);
		if (
			pointer?.agentId === item.agentId &&
			(pointer.id === item.id ||
				(item.providerSessionId &&
					pointer.providerSessionId === item.providerSessionId))
		)
			rememberPaperConversation(
				storage,
				vaultPath,
				paper,
				{ id: "draft", agentId: item.agentId },
				owner,
			);
	};
	useEffect(() => {
		if (hydratingSessionId) return;
		const session = agentSessionStore
			.getState()
			.sessions.find((item) => item.id === activeTabId);
		setToolAskUserRequest(
			session?.status === "running"
				? pendingQuestionFromLines(session.lines, activeTabId)
				: null,
		);
	}, [activeTabId, hydratingSessionId, setToolAskUserRequest]);

	return {
		t,
		conversationScope: scopeKey,
		paperContext: Boolean(paperPath),
		// Transcript
		lines,
		activeTabId,
		hydratingSessionId,
		selected,
		activeTabIsRunning,
		/** Loading phase of the active tab's in-flight turn (starting / waiting / reconnecting). */
		activePhase: phaseBySession[activeTabId] ?? null,
		submitting,
		switching: switching || Boolean(hydratingSessionId),
		editingLineId,
		editingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		setEditingText,
		cancelEditingMessage,
		resendEditedMessage,
		startEditingMessage,
		send,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		// History
		sessionHistory: sessionHistory.filter(
			(session) =>
				session.agentId === selectedAgentId &&
				sessionScope(session) === scopeKey,
		),
		historyOpen,
		setHistoryOpen,
		newConversation,
		historyLoading,
		openHistorySession,
		deleteHistorySession,
		// Agent switcher
		options,
		selectedAgentId,
		hasRunningSessions,
		selectAgent,
		// Composer
		composerText,
		setComposerText,
		onComposerTextChangeFromUser,
		composerInputRef,
		setComposerMenuDismissed,
		setMentionActiveIndex,
		setQuickActiveIndex,
		handleComposerMenuKeyDown,
		handleComposerDragOver,
		handleComposerDrop,
		currentFilePath,
		currentFileLabel,
		mentionChipPaths,
		selectionChips,
		visualDrafts,
		removeVisualDraft,
		directoryPathSet,
		paperPathSet,
		labelForPath,
		removeContextPath,
		selectedSkills,
		setSelectedSkillIds,
		showMentionMenu,
		mentionBrowseRoot,
		mentionOptions,
		mentionActiveIndex,
		mentionCandidates,
		leaveMentionFolder,
		enterMentionFolder,
		attachMention,
		showQuickMenu,
		quickOptions,
		quickActiveIndex,
		pickQuickOption,
		removeSkill,
		modelSelectorOpen,
		setModelSelectorOpen,
		models,
		groupedModels,
		modelId,
		selectedModelName,
		favoriteIds,
		warming,
		pickModel,
		toggleFavorite,
		collaborationOptions,
		collaborationModeId,
		selectedCollaborationName,
		pickCollaborationMode,
		effortOptions,
		reasoningEffort,
		pickReasoningEffort,
		activeUsage,
		fastAvailable,
		fastEnabled,
		setFastEnabled,
		cancelCurrentRun,
		// Permission
		permissionRequest,
		setPermissionRequest,
		// Form elicitation (request_user_input)
		elicitationRequest,
		setElicitationRequest,
		// Grok ask-user extension
		askUserRequest,
		setAskUserRequest,
		// Tool-shaped ask promoted to composer
		toolAskUserRequest,
		setToolAskUserRequest,
		answerToolAskUser,
		// Refs used by composer submit race guards
		switchingRef,
		submittingRef,
	};
}
