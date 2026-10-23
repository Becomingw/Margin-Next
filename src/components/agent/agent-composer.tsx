import { ImageIcon } from "lucide-react";
import type {
	KeyboardEvent,
	DragEvent as ReactDragEvent,
	RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
	ComposerImageAttachments,
	ComposerSubmitControl,
} from "@/components/agent/composer/composer-attachments";
import { ComposerContextChips } from "@/components/agent/composer/composer-context-chips";
import { ComposerDropTarget } from "@/components/agent/composer/composer-drop-target";
import type { ComposerInlineInputHandle } from "@/components/agent/composer/composer-inline-input";
import { ComposerInlineInput } from "@/components/agent/composer/composer-inline-input";
import { ComposerMentionMenu } from "@/components/agent/composer/composer-mention-menu";
import { ComposerQueue } from "@/components/agent/composer/composer-queue";
import {
	ComposerQuickMenu,
	type QuickOption,
} from "@/components/agent/composer/composer-quick-menus";
import { ComposerToolbar } from "@/components/agent/composer/composer-toolbar";
import { useComposerFileDrag } from "@/components/agent/hooks/use-composer-file-drag";
import type { QueuedPrompt } from "@/components/agent/types";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import type { AgentSkill, PromptImage } from "@/lib/agent";
import {
	COMPOSER_IMAGE_ACCEPT,
	COMPOSER_IMAGE_MAX_BYTES,
	COMPOSER_IMAGE_MAX_FILES,
	fileUiPartsToPromptImages,
} from "@/lib/agent/prompt-image";
import type { SelectionContext } from "@/lib/agent/selection-store";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";

export type AgentComposerProps = {
	autoFocus: boolean;
	/** Short window: one row with the send button inline. */
	compact?: boolean;
	activeTabIsRunning: boolean;
	switching: boolean;
	submitting: boolean;
	composerText: string;
	onComposerTextChange: (text: string) => void;
	onSubmit: (text: string, images?: PromptImage[]) => Promise<void>;
	onComposerKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onComposerDragOver: (e: ReactDragEvent) => void;
	onComposerDrop: (e: ReactDragEvent) => void;
	onDismissComposerMenu: () => void;
	messageQueue: QueuedPrompt[];
	onRemoveQueuedMessage: (id: string) => void;
	currentFilePath: string | null;
	currentFileLabel: string;
	mentionChipPaths: string[];
	selectionChips: SelectionContext[];
	onRemoveSelection: (id: string) => void;
	visualDrafts: PdfVisualDraft[];
	onRemoveVisualDraft: (id: string) => void;
	directoryPathSet: ReadonlySet<string>;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	onRemoveContextPath: (path: string) => void;
	selectedSkills: AgentSkill[];
	onRemoveSkill: (skillId: string) => void;
	showMentionMenu: boolean;
	mentionBrowseRoot: string | null;
	mentionOptions: string[];
	mentionActiveIndex: number;
	mentionCandidates: string[];
	onLeaveMentionFolder: () => void;
	onEnterMentionFolder: (path: string) => void;
	onAttachMention: (path: string) => void;
	onMentionActiveIndexChange: (index: number) => void;
	showQuickMenu: boolean;
	quickOptions: QuickOption[];
	quickActiveIndex: number;
	onPickQuickOption: (option: QuickOption) => void;
	onQuickActiveIndexChange: (index: number) => void;
	activeUsage: { used: number; size: number } | null;
	onCancelRun: () => void;
	composerInputRef: RefObject<ComposerInlineInputHandle | null>;
};

export function AgentComposer(props: AgentComposerProps) {
	const {
		autoFocus,
		compact = false,
		activeTabIsRunning,
		switching,
		submitting,
		composerText,
		onComposerTextChange,
		onSubmit,
		onComposerKeyDown,
		onComposerDragOver,
		onComposerDrop,
		onDismissComposerMenu,
		visualDrafts,
		showMentionMenu,
		showQuickMenu,
		mentionActiveIndex,
		quickActiveIndex,
		onCancelRun,
	} = props;
	const { t } = useTranslation("agent");
	const hasComposerText = Boolean(composerText.trim());
	const hasVisualDrafts = visualDrafts.length > 0;
	// Attachments live inside PromptInput; base gate ignores them (see ComposerSubmitControl).
	const canSubmitBase = hasComposerText || hasVisualDrafts;
	const composerMenuOpen = showMentionMenu || showQuickMenu;
	const hasQueuedMessages = props.messageQueue.length > 0;
	const {
		shellRef,
		isFileDragOver,
		onFileDragEnter,
		onFileDragLeave,
		onFileDragOver,
		onFileDropHighlightEnd,
	} = useComposerFileDrag();

	const contextChips =
		props.currentFilePath || visualDrafts.length > 0 ? (
			<div
				className={cn(
					"flex shrink-0 items-center gap-1.5",
					compact ? "flex-nowrap overflow-hidden" : "mb-1.5 flex-wrap",
				)}
			>
				<ComposerContextChips
					compact={compact}
					currentFilePath={props.currentFilePath}
					currentFileLabel={props.currentFileLabel}
					mentionChipPaths={[]}
					selectionChips={[]}
					onRemoveSelection={props.onRemoveSelection}
					visualDrafts={visualDrafts}
					onRemoveVisualDraft={props.onRemoveVisualDraft}
					directoryPathSet={props.directoryPathSet}
					paperPathSet={props.paperPathSet}
					labelForPath={props.labelForPath}
					onRemoveContextPath={props.onRemoveContextPath}
				/>
			</div>
		) : null;

	return (
		<div
			className={cn(
				// Queue sits in normal flow above the shell; fixed height applies only
				// to the input shell so the waitlist never covers the composer.
				// Keep the same horizontal inset and bottom gap in both modes so
				// the InputGroup width / distance to the panel bottom do not jump
				// when crossing the compact height threshold.
				"flex shrink-0 flex-col px-3 pb-3",
				compact ? "gap-1 pt-2" : "gap-2 pt-3",
			)}
		>
			{hasQueuedMessages ? (
				<ComposerQueue
					compact={compact}
					messageQueue={props.messageQueue}
					onRemoveQueuedMessage={props.onRemoveQueuedMessage}
				/>
			) : null}
			<div
				ref={shellRef}
				data-composer-drop-shell
				// Hugs its content: the input grows with the draft (capped in
				// ComposerInlineInput) instead of reserving a fixed height.
				className="relative flex min-h-0 flex-col gap-1.5 overflow-hidden"
			>
				{/* Compact mode keeps the chips on their own line above the single-row input. */}
				{compact ? contextChips : null}
				<div className={cn("relative min-h-0", compact && "flex items-end")}>
					<PromptInput
						className={cn("w-full", compact && "flex items-end")}
						inputGroupClassName={cn(
							"!flex h-auto min-h-0 !flex-col overflow-hidden rounded-xl border border-input bg-card transition-[background-color,box-shadow,border-color] duration-150",
							// Keep the same surface while any child is disabled or a run is
							// in progress — never dim / recolor the composer for "processing".
							"has-disabled:bg-card has-disabled:opacity-100 dark:has-disabled:bg-card dark:bg-card",
							// Focus: the input border turns copper inside a soft ring (docs/design.md).
							"has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20",
							isFileDragOver &&
								"border-primary/55 bg-primary/5 shadow-[inset_0_0_0_1px] shadow-primary/25 ring-2 ring-primary/35 dark:bg-primary/5",
						)}
						accept={COMPOSER_IMAGE_ACCEPT}
						multiple
						maxFiles={COMPOSER_IMAGE_MAX_FILES}
						maxFileSize={COMPOSER_IMAGE_MAX_BYTES}
						onError={(err) => {
							if (err.code === "accept") {
								notifyError(t("composer.imageAcceptError"));
								return;
							}
							notifyError(err.message);
						}}
						onDragEnter={onFileDragEnter}
						onDragLeave={onFileDragLeave}
						onDragOver={onFileDragOver}
						onDrop={onFileDropHighlightEnd}
						onSubmit={async ({ files }) => {
							const images = fileUiPartsToPromptImages(files);
							// Prefer controlled draft (includes inline token markers).
							await onSubmit(composerText, images.length ? images : undefined);
						}}
					>
						<PromptInputBody>
							<Popover
								open={composerMenuOpen}
								modal={false}
								onOpenChange={(open) => {
									if (!open) onDismissComposerMenu();
								}}
							>
								<PopoverAnchor asChild>
									<ComposerDropTarget
										className={cn(
											"relative flex w-full overflow-hidden",
											compact
												? // Single-line, vertically centered. py-2.5 matches the
													// expanded footer pb-2.5 so the send button sits on the
													// same bottom inset when crossing the compact threshold.
													"min-h-0 flex-row items-center gap-1 px-3 py-2.5"
												: "min-h-0 flex-col px-3 pt-3",
										)}
										onVaultPathDragOver={onComposerDragOver}
										onVaultPathDrop={onComposerDrop}
									>
										{/* Current file / visual drafts sit inside the box, above the text. */}
										{compact ? null : contextChips}
										<ComposerImageAttachments compact={compact} />
										{/* The three menus stay in this Popover subtree on purpose — PopoverContent needs its context. */}
										{showMentionMenu ? (
											<ComposerMentionMenu
												mentionBrowseRoot={props.mentionBrowseRoot}
												mentionOptions={props.mentionOptions}
												mentionActiveIndex={mentionActiveIndex}
												mentionCandidates={props.mentionCandidates}
												directoryPathSet={props.directoryPathSet}
												paperPathSet={props.paperPathSet}
												labelForPath={props.labelForPath}
												onLeaveMentionFolder={props.onLeaveMentionFolder}
												onEnterMentionFolder={props.onEnterMentionFolder}
												onAttachMention={props.onAttachMention}
												onMentionActiveIndexChange={
													props.onMentionActiveIndexChange
												}
											/>
										) : null}
										{showQuickMenu ? (
											<ComposerQuickMenu
												options={props.quickOptions}
												activeIndex={quickActiveIndex}
												onPick={props.onPickQuickOption}
												onActiveIndexChange={props.onQuickActiveIndexChange}
											/>
										) : null}
										<ComposerInlineInput
											ref={props.composerInputRef}
											autoFocus={Boolean(autoFocus)}
											compact={compact}
											value={composerText}
											onValueChange={onComposerTextChange}
											onKeyDown={onComposerKeyDown}
											disabled={switching}
											labelForPath={props.labelForPath}
											skillLabel={(skillId) =>
												props.selectedSkills.find((s) => s.id === skillId)
													?.name ?? skillId
											}
											aria-expanded={showMentionMenu || showQuickMenu}
											aria-autocomplete="list"
											aria-controls={
												showMentionMenu
													? "agent-mention-menu"
													: showQuickMenu
														? "agent-quick-menu"
														: undefined
											}
											aria-activedescendant={
												showMentionMenu
													? `agent-mention-option-${mentionActiveIndex}`
													: showQuickMenu
														? `agent-quick-option-${quickActiveIndex}`
														: undefined
											}
											placeholder={
												activeTabIsRunning ? "" : t("composer.placeholder")
											}
										/>
										{compact ? (
											<ComposerSubmitControl
												canSubmitBase={canSubmitBase}
												switching={switching}
												submitting={submitting}
												activeTabIsRunning={activeTabIsRunning}
												compact
												onCancelRun={onCancelRun}
											/>
										) : null}
									</ComposerDropTarget>
								</PopoverAnchor>
							</Popover>
						</PromptInputBody>
						{compact ? null : (
							<PromptInputFooter className="flex-wrap items-end gap-x-2 gap-y-1.5 px-3 pb-2.5">
								<PromptInputTools className="min-w-0 flex-1 flex-wrap gap-1">
									<ComposerToolbar
										switching={switching}
										activeUsage={props.activeUsage}
										onOpenSkills={() =>
											props.composerInputRef.current?.insertAtCursor(
												composerText && !/\s$/.test(composerText) ? " /" : "/",
												true,
											)
										}
									/>
								</PromptInputTools>
								<ComposerSubmitControl
									canSubmitBase={canSubmitBase}
									switching={switching}
									submitting={submitting}
									activeTabIsRunning={activeTabIsRunning}
									onCancelRun={onCancelRun}
								/>
							</PromptInputFooter>
						)}
					</PromptInput>
					{isFileDragOver ? (
						<div
							className={cn(
								"pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl",
								"border-2 border-primary/50 border-dashed bg-primary/10 backdrop-blur-[1px]",
							)}
							aria-hidden
						>
							<div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/90 px-3 py-1.5 text-primary text-xs font-medium shadow-floating">
								<ImageIcon className="size-3.5 shrink-0" />
								<span>{t("composer.dropImageHint")}</span>
							</div>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
