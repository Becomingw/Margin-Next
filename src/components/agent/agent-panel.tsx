import { memo, useEffect, useState } from "react";
import {
	AgentAskUserSurface,
	isAskUserSurfaceActive,
} from "@/components/agent/agent-ask-user-surface";
import { AgentComposer } from "@/components/agent/agent-composer";
import { AgentConfigBar } from "@/components/agent/agent-config-bar";
import { SidebarHistoryTrailing } from "@/components/agent/agent-history";
import { AgentPermissionDialog } from "@/components/agent/agent-permission-dialog";
import { AgentSwitcher } from "@/components/agent/agent-switcher";
import { ChatTranscript } from "@/components/agent/chat-transcript";
import type { AgentPanelProps } from "@/components/agent/types";
import { useAgentPanel } from "@/components/agent/use-agent-panel";
import { PaneHeader } from "@/components/shell/pane-header";
import { removeSelection } from "@/lib/agent/selection-store";
import { agentWelcomeTitle } from "@/lib/agent/welcome-context";
import { cn } from "@/lib/core/utils";

/**
 * Below this app window height the composer collapses to a single row with
 * the send button inline; otherwise it grows with its content (capped in CSS).
 */
const WINDOW_COMPACT_THRESHOLD_PX = 600;

const isShortWindow = () =>
	typeof window !== "undefined" &&
	window.innerHeight < WINDOW_COMPACT_THRESHOLD_PX;

export type { AgentPanelProps } from "@/components/agent/types";

export const AgentPanel = memo(function AgentPanel({
	vaultPath,
	selectedPath = null,
	selectedPaperTitle = null,
	vaultMarkdownPaths = [],
	vaultDirectoryPaths = [],
	vaultPaperPaths = [],
	paperMetaByRelPath = null,
	paperTreeLabelMode = "title-author",
	className,
	headerActions,
	autoFocus = false,
	title = "Chat",
	onOpenAgentSettings,
	onOpenSource,
}: AgentPanelProps) {
	const panel = useAgentPanel({
		vaultPath,
		selectedPath,
		selectedPaperTitle,
		vaultMarkdownPaths,
		vaultDirectoryPaths,
		vaultPaperPaths,
		paperMetaByRelPath,
		paperTreeLabelMode,
	});
	const [composerCompact, setComposerCompact] = useState(isShortWindow);
	useEffect(() => {
		const handleResize = () => setComposerCompact(isShortWindow());
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	const {
		lines,
		activeTabId,
		hydratingSessionId,
		selected,
		activeTabIsRunning,
		activePhase,
		submitting,
		switching,
		editingLineId,
		editingText,
		editTextareaRef,
		editCompositionProps,
		isEditBlockedByIme,
		setEditingText,
		cancelEditingMessage,
		resendEditedMessage,
		startEditingMessage,
		submitComposer,
		messageQueue,
		removeQueuedMessage,
		sessionHistory,
		historyOpen,
		setHistoryOpen,
		newConversation,
		openHistorySession,
		deleteHistorySession,
		historyLoading,
		options,
		selectedAgentId,
		hasRunningSessions,
		selectAgent,
		composerText,
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
		permissionRequest,
		setPermissionRequest,
		elicitationRequest,
		setElicitationRequest,
		askUserRequest,
		setAskUserRequest,
		toolAskUserRequest,
		setToolAskUserRequest,
		answerToolAskUser,
		switchingRef,
		submittingRef,
	} = panel;

	// Questionnaire and free-text composer are mutually exclusive.
	const askUserActive = isAskUserSurfaceActive({
		elicitationRequest,
		askUserRequest,
		toolAskUserRequest,
	});

	return (
		<section
			data-agent-panel
			className={cn(
				"flex h-full min-h-0 select-none flex-col bg-sidebar",
				className,
			)}
			aria-label={title}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<PaneHeader
					// The config bar below closes the header block.
					className="border-b-0"
					trailing={
						<SidebarHistoryTrailing
							historyOpen={historyOpen}
							onHistoryOpenChange={setHistoryOpen}
							sessionHistory={sessionHistory}
							activeTabId={activeTabId}
							submitting={submitting}
							headerActions={headerActions}
							onNewConversation={newConversation}
							onOpenSession={openHistorySession}
							onDeleteSession={deleteHistorySession}
							historyLoading={historyLoading}
						/>
					}
				>
					<AgentSwitcher
						options={options}
						selected={selected}
						selectedAgentId={selectedAgentId}
						disabled={hasRunningSessions || switching || submitting}
						onSelect={(opt) => void selectAgent(opt)}
						onOpenAgentSettings={onOpenAgentSettings}
					/>
				</PaneHeader>

				<AgentConfigBar
					modelSelectorOpen={modelSelectorOpen}
					onModelSelectorOpenChange={setModelSelectorOpen}
					models={models}
					groupedModels={groupedModels}
					modelId={modelId}
					selectedModelName={selectedModelName}
					favoriteIds={favoriteIds}
					warming={warming}
					onPickModel={pickModel}
					onToggleFavorite={toggleFavorite}
					collaborationOptions={collaborationOptions}
					collaborationModeId={collaborationModeId}
					selectedCollaborationName={selectedCollaborationName}
					onPickCollaborationMode={pickCollaborationMode}
					effortOptions={effortOptions}
					reasoningEffort={reasoningEffort}
					onReasoningEffortChange={pickReasoningEffort}
					fastAvailable={fastAvailable}
					fastEnabled={fastEnabled}
					onFastEnabledToggle={() => setFastEnabled((current) => !current)}
				/>

				{/* Size container: the composer caps its growth at a share of this height. */}
				<div className="flex min-h-0 flex-1 flex-col [container-type:size]">
					<ChatTranscript
						welcomeTitle={agentWelcomeTitle({
							scope: panel.conversationScope,
							paperTitle: selectedPaperTitle,
							paperMeta: paperMetaByRelPath,
							hasVault: Boolean(vaultPath),
						})}
						lines={lines}
						activeTabId={activeTabId}
						hydratingSessionId={hydratingSessionId}
						compact={composerCompact}
						activeTabIsRunning={activeTabIsRunning}
						phase={activePhase}
						submitting={submitting}
						switching={switching}
						editingLineId={editingLineId}
						editingText={editingText}
						editTextareaRef={editTextareaRef}
						editCompositionProps={editCompositionProps}
						isEditBlockedByIme={isEditBlockedByIme}
						onEditingTextChange={setEditingText}
						onCancelEditing={cancelEditingMessage}
						onResendEdited={(lineId) => void resendEditedMessage(lineId)}
						onStartEditing={startEditingMessage}
						onOpenSource={onOpenSource}
					/>

					{/* Questionnaire replaces the composer until submit/cancel. */}
					<AgentAskUserSurface
						elicitationRequest={elicitationRequest}
						onElicitationResolved={() => setElicitationRequest(null)}
						askUserRequest={askUserRequest}
						onAskUserResolved={() => setAskUserRequest(null)}
						toolAskUserRequest={toolAskUserRequest}
						onToolAskUserResolved={() => setToolAskUserRequest(null)}
						onAnswerToolAskUser={answerToolAskUser}
						disabled={switching}
					/>

					{!askUserActive ? (
						<AgentComposer
							autoFocus={autoFocus}
							compact={composerCompact}
							activeTabIsRunning={activeTabIsRunning}
							switching={switching}
							submitting={submitting}
							composerText={composerText}
							onComposerTextChange={(text) => {
								onComposerTextChangeFromUser(text);
								setComposerMenuDismissed(false);
								setMentionActiveIndex(0);
								setQuickActiveIndex(0);
							}}
							onSubmit={async (text, images) => {
								if (switchingRef.current || submittingRef.current) {
									// Keep PromptInput attachments when the submit is rejected.
									throw new Error("composer busy");
								}
								const ok = await submitComposer(text, undefined, images);
								if (!ok) {
									// Preserve pasted/picked images when send early-returns (e.g. no agent).
									throw new Error("composer submit rejected");
								}
							}}
							onComposerKeyDown={handleComposerMenuKeyDown}
							onComposerDragOver={handleComposerDragOver}
							onComposerDrop={handleComposerDrop}
							onDismissComposerMenu={() => setComposerMenuDismissed(true)}
							messageQueue={messageQueue}
							onRemoveQueuedMessage={removeQueuedMessage}
							currentFilePath={currentFilePath}
							currentFileLabel={currentFileLabel}
							mentionChipPaths={mentionChipPaths}
							selectionChips={selectionChips}
							onRemoveSelection={removeSelection}
							visualDrafts={visualDrafts}
							onRemoveVisualDraft={removeVisualDraft}
							directoryPathSet={directoryPathSet}
							paperPathSet={paperPathSet}
							labelForPath={labelForPath}
							onRemoveContextPath={removeContextPath}
							selectedSkills={selectedSkills}
							onRemoveSkill={removeSkill}
							showMentionMenu={showMentionMenu}
							mentionBrowseRoot={mentionBrowseRoot}
							mentionOptions={mentionOptions}
							mentionActiveIndex={mentionActiveIndex}
							mentionCandidates={mentionCandidates}
							onLeaveMentionFolder={leaveMentionFolder}
							onEnterMentionFolder={enterMentionFolder}
							onAttachMention={attachMention}
							onMentionActiveIndexChange={setMentionActiveIndex}
							showQuickMenu={showQuickMenu}
							quickOptions={quickOptions}
							quickActiveIndex={quickActiveIndex}
							onPickQuickOption={pickQuickOption}
							onQuickActiveIndexChange={setQuickActiveIndex}
							activeUsage={activeUsage}
							composerInputRef={composerInputRef}
							onCancelRun={() => void cancelCurrentRun()}
						/>
					) : null}
				</div>
			</div>

			<AgentPermissionDialog
				permissionRequest={permissionRequest}
				onDismiss={() => setPermissionRequest(null)}
			/>
		</section>
	);
});
