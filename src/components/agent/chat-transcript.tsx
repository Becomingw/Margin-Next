import { Check, CircleAlert, CopyIcon, Pencil, Sparkles } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { RefObject } from "react";
import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { AgentWelcome } from "@/components/agent/agent-welcome";
import { ChatReferences } from "@/components/agent/chat-references";
import {
	ChatAttachedImages,
	ChatVisualAnnotations,
	formatUserLineForCopy,
} from "@/components/agent/chat-visual-annotations";
import {
	transcriptLineKey,
	useTranscriptVirtualizer,
} from "@/components/agent/hooks/use-transcript-virtualizer";
import {
	ProducedFiles,
	StreamingActivityRow,
	TurnWorkSummary,
} from "@/components/agent/turn-process";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentPhaseState } from "@/lib/agent/api";
import {
	type AgentPart,
	agentTextFromParts,
	type ChatLine,
	copyText,
} from "@/lib/agent/chat-state";
import {
	extractSkillIds,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import { selectionsPromptBlock } from "@/lib/agent/selection-store";
import { producedFiles, splitTurn } from "@/lib/agent/tool-activity";

/** On tab switch, jump to the latest messages instead of keeping the old scroll position. */
function TabScrollToBottom({ activeTabId }: { activeTabId: string }) {
	const { scrollToBottom } = useStickToBottomContext();
	const prevTabIdRef = useRef(activeTabId);

	useEffect(() => {
		if (prevTabIdRef.current !== activeTabId) {
			prevTabIdRef.current = activeTabId;
			scrollToBottom({ animation: "instant" });
		}
	}, [activeTabId, scrollToBottom]);

	return null;
}

function HistorySessionShimmer() {
	const { t } = useTranslation("agent");
	return (
		<div className="flex w-full flex-col gap-6 pt-2" aria-live="polite">
			<div className="flex justify-end">
				<div className="flex w-[78%] max-w-[32rem] flex-col gap-2 rounded-lg bg-muted px-3 py-2.5">
					<Skeleton className="h-4 w-11/12 bg-muted-foreground/15" />
					<Skeleton className="h-4 w-7/12 bg-muted-foreground/15" />
				</div>
			</div>
			<div className="flex w-full max-w-[38rem] flex-col gap-3">
				<Shimmer className="text-sm" as="p">
					{t("history.restoring")}
				</Shimmer>
				<div className="flex flex-col gap-2">
					<Skeleton className="h-4 w-10/12" />
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-8/12" />
				</div>
			</div>
		</div>
	);
}

type ImeGuardEvent = {
	nativeEvent?: { isComposing?: boolean; keyCode?: number };
	isComposing?: boolean;
	keyCode?: number;
};

/**
 * Row callbacks bundled behind one identity-stable object so memoized rows
 * bail out during streaming. Wrappers read the latest handler from a ref, so
 * stability never means stale closures.
 */
type RowHandlers = {
	isEditBlockedByIme: (event: ImeGuardEvent) => boolean;
	onEditingTextChange: (text: string) => void;
	onCancelEditing: () => void;
	onResendEdited: (lineId: string) => void;
	onStartEditing: (lineId: string, text: string) => void;
	onOpenSource?: (source: string) => void;
	editCompositionProps: {
		onCompositionStart?: () => void;
		onCompositionEnd?: () => void;
	};
};

/** Copy button with a brief checkmark feedback state. */
function CopyAction({ text }: { text: string }) {
	const { t } = useTranslation("agent");
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		try {
			await copyText(text);
			setCopied(true);
		} catch {
			// Keep the existing silent failure behavior.
		}
	}, [text]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<MessageAction
			tooltip={copied ? t("copied") : t("copy")}
			label={copied ? t("copied") : t("copy")}
			onClick={handleCopy}
		>
			{copied ? (
				<Check className="size-3.5 text-green-600" />
			) : (
				<CopyIcon className="size-3.5" />
			)}
		</MessageAction>
	);
}

/**
 * One transcript line. Memoized so a streaming update to the last line does
 * not re-render the whole history: `updateSessionLines` keeps unchanged line
 * references stable, and every other prop is either a primitive or the
 * identity-stable handlers object.
 */
const ChatTranscriptRow = memo(function ChatTranscriptRow({
	line,
	activeTabId,
	activeTabIsRunning,
	submitting,
	switching,
	isEditing,
	editingText,
	editTextareaRef,
	handlers,
	partOpenState,
	onPartOpenChange,
	phase = null,
}: {
	line: ChatLine;
	activeTabId: string;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	isEditing: boolean;
	/** Empty string for non-editing rows so keystrokes only re-render the edited row. */
	editingText: string;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	handlers: RowHandlers;
	/**
	 * Lifted Reasoning/Tool/Plan open state (key = `${rowKey}:${part.id}`) so
	 * virtualized rows keep their fold state across unmount/remount.
	 */
	partOpenState: Record<string, boolean>;
	onPartOpenChange: (key: string, open: boolean) => void;
	/** Loading phase, only passed to the last streaming agent row. */
	phase?: AgentPhaseState | null;
}) {
	const { t } = useTranslation("agent");
	const { onOpenSource } = handlers;

	if (line.kind === "user") {
		const visuals = line.visualAnnotations ?? [];
		const attachedImages = line.images ?? [];
		if (isEditing) {
			return (
				<Message from="user">
					{line.references?.length ? (
						<ChatReferences references={line.references} />
					) : null}
					{/* Chips sit above the bubble, matching composer context chips. */}
					{visuals.length > 0 ? (
						<ChatVisualAnnotations annotations={visuals} />
					) : null}
					{attachedImages.length > 0 ? (
						<ChatAttachedImages images={attachedImages} />
					) : null}
					<div className="ml-auto flex w-full flex-col gap-2 rounded-lg bg-black/5 px-3 py-2.5 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/15">
						<textarea
							ref={editTextareaRef}
							className="max-h-60 min-h-16 w-full resize-none overflow-y-auto bg-transparent text-foreground text-sm leading-6 outline-none"
							value={editingText}
							onChange={(event) =>
								handlers.onEditingTextChange(event.currentTarget.value)
							}
							{...handlers.editCompositionProps}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									handlers.onCancelEditing();
								} else if (
									event.key === "Enter" &&
									!event.shiftKey &&
									!handlers.isEditBlockedByIme(event)
								) {
									event.preventDefault();
									handlers.onResendEdited(line.id);
								}
							}}
						/>
						<div className="flex items-center justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={handlers.onCancelEditing}
							>
								{t("edit.cancel")}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!editingText.trim() || submitting || switching}
								onClick={() => handlers.onResendEdited(line.id)}
							>
								{t("edit.resend")}
							</Button>
						</div>
					</div>
				</Message>
			);
		}
		const userDisplay = stripPromptEnvelopeForDisplay(
			stripInlineTokens(line.text),
		);
		// Skills picked for this turn stay visible as small pills.
		const skillIds = extractSkillIds(line.text);
		// Never render Codex env / Host system envelopes as user bubbles.
		if (
			!userDisplay &&
			visuals.length === 0 &&
			attachedImages.length === 0 &&
			!line.references?.length
		)
			return null;
		const copyPayload = [
			formatUserLineForCopy({
				text: userDisplay,
				visualAnnotations: visuals,
				images: attachedImages,
			}),
			selectionsPromptBlock(line.references ?? []),
		]
			.filter(Boolean)
			.join("\n\n");
		return (
			<Message from="user" className="max-w-[85%]">
				{skillIds.length ? (
					<div className="mb-1.5 ml-auto flex max-w-full flex-wrap justify-end gap-1">
						{skillIds.map((id) => (
							<span
								key={id}
								className="inline-flex max-w-48 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs"
								title={t("skill.applied", { name: id })}
							>
								<Sparkles className="size-3 shrink-0" aria-hidden />
								<span className="truncate">{id}</span>
							</span>
						))}
					</div>
				) : null}
				{line.references?.length ? (
					<ChatReferences references={line.references} />
				) : null}
				{/* Visual chips above the text bubble (not inside it). */}
				{visuals.length > 0 ? (
					<ChatVisualAnnotations annotations={visuals} />
				) : null}
				{/*
				 * Right-anchored content block. Hover actions float at its
				 * bottom-left corner, out of layout flow — a hidden action row
				 * used to add a blank line between the user turn and the reply.
				 */}
				<div className="relative ml-auto w-fit max-w-full">
					{attachedImages.length > 0 ? (
						<ChatAttachedImages images={attachedImages} />
					) : null}
					{/* Free-text only: skip empty bubble when the turn is image/visual-only. */}
					{userDisplay ? (
						<MessageContent className="rounded-xl px-4 py-2.5 group-[.is-user]:rounded-xl group-[.is-user]:rounded-br-md">
							<MessageResponse className="text-base leading-relaxed">
								{userDisplay}
							</MessageResponse>
						</MessageContent>
					) : null}
					{/* Hovers beside the bubble's bottom-left, outside the box. */}
					<MessageActions className="absolute right-full bottom-0 mr-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
						{activeTabIsRunning || !userDisplay ? null : (
							<MessageAction
								tooltip={t("edit.action")}
								label={t("edit.action")}
								disabled={submitting || switching}
								onClick={() => handlers.onStartEditing(line.id, userDisplay)}
							>
								<Pencil className="size-3.5" />
							</MessageAction>
						)}
						<CopyAction text={copyPayload} />
					</MessageActions>
				</div>
			</Message>
		);
	}
	if (line.kind === "agent") {
		// Include activeTabId so per-part Reasoning/Tool state never
		// leaks across sessions when history line ids collide
		// (e.g. Codex thread message ids).
		const rowKey = `${activeTabId}:${line.id}`;
		const parts = line.parts;
		const lastIndex = parts.length - 1;
		const isStreaming = Boolean(line.streaming);

		const { process, answer } = splitTurn(parts, { streaming: isStreaming });
		// Copy the reply itself, not the narration between tool calls.
		const agentText = agentTextFromParts(answer);
		const renderAnswer = (part: AgentPart) => {
			if (part.type !== "text" || !part.text) return null;
			const isAnimating =
				isStreaming &&
				parts.indexOf(part) === lastIndex &&
				part.text.length > 0;
			return (
				<div key={`${rowKey}:${part.id}`} className="min-w-0">
					<MessageResponse
						isAnimating={isAnimating}
						onOpenSource={onOpenSource}
					>
						{part.text}
					</MessageResponse>
				</div>
			);
		};
		// Work (tools, reasoning, plan, narration) stays out of the way: a live
		// one-line status while running, a folded summary once done.
		const showActivity =
			isStreaming && (process.length > 0 || answer.length === 0 || phase);

		return (
			<div className="flex w-full flex-col gap-3">
				<Message from="assistant">
					<MessageContent className="w-full gap-3 text-base leading-relaxed">
						{showActivity ? (
							<StreamingActivityRow
								parts={parts}
								phase={phase}
								startedAt={line.startedAt}
							/>
						) : !isStreaming && process.length > 0 ? (
							<TurnWorkSummary
								rowKey={rowKey}
								process={process}
								durationMs={line.durationMs}
								partOpenState={partOpenState}
								onPartOpenChange={onPartOpenChange}
								onOpenSource={onOpenSource}
							/>
						) : null}
						{answer.map(renderAnswer)}
						{isStreaming ? null : (
							<ProducedFiles paths={producedFiles(parts)} />
						)}
					</MessageContent>
					{!line.streaming && agentText ? (
						<MessageActions className="-mt-2 -mb-3 h-6 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
							<CopyAction text={agentText} />
						</MessageActions>
					) : null}
				</Message>
			</div>
		);
	}
	if (line.kind === "error") {
		return (
			<Message from="assistant">
				<MessageContent className="w-full">
					<div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
						<CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
						<MessageResponse className="text-sm">{line.text}</MessageResponse>
					</div>
				</MessageContent>
			</Message>
		);
	}
	// Turn-level notices (stopped, switched agent…) as a quiet centred divider.
	return (
		<div className="flex items-center gap-3 px-1 text-muted-foreground text-xs">
			<span className="h-px flex-1 bg-hairline-soft" aria-hidden />
			<span className="max-w-[70%] truncate">{line.text}</span>
			<span className="h-px flex-1 bg-hairline-soft" aria-hidden />
		</div>
	);
});

/**
 * Renders transcript rows. Must live inside <Conversation> so it can reach
 * the StickToBottom scroll viewport via context. Long transcripts switch to
 * windowed rendering (absolute rows inside a totalSize container); short ones
 * keep the plain flex/gap layout.
 */
function TranscriptBody({
	lines,
	activeTabId,
	activeTabIsRunning,
	submitting,
	switching,
	editingLineId,
	editingText,
	editTextareaRef,
	handlers,
	partOpenState,
	onPartOpenChange,
	forceVirtualize,
	phase,
}: {
	lines: ChatLine[];
	activeTabId: string;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	editingLineId: string | null;
	editingText: string;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	handlers: RowHandlers;
	partOpenState: Record<string, boolean>;
	onPartOpenChange: (key: string, open: boolean) => void;
	forceVirtualize?: boolean;
	/** Loading phase, forwarded only to the last streaming agent row. */
	phase?: AgentPhaseState | null;
}) {
	const { rowVirtualizer, virtualized } = useTranscriptVirtualizer({
		lines,
		activeTabId,
		forceVirtualize,
	});

	// The edit button can target turns far above the viewport; bring the row
	// into the mounted window when windowed rendering is active.
	useEffect(() => {
		if (!virtualized || !editingLineId) return;
		const index = lines.findIndex((line) => line.id === editingLineId);
		if (index >= 0) {
			rowVirtualizer.scrollToIndex(index, { align: "auto" });
		}
	}, [editingLineId, virtualized, lines, rowVirtualizer]);

	// Only the last streaming agent row carries the phase, so memoized
	// history rows do not re-render on every phase change.
	let lastStreamingAgentId: string | null = null;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line.kind === "agent" && line.streaming) {
			lastStreamingAgentId = line.id;
			break;
		}
	}

	const renderRow = (line: ChatLine) => {
		const isEditing = editingLineId === line.id;
		return (
			<ChatTranscriptRow
				line={line}
				activeTabId={activeTabId}
				activeTabIsRunning={activeTabIsRunning}
				submitting={submitting}
				switching={switching}
				isEditing={isEditing}
				editingText={isEditing ? editingText : ""}
				editTextareaRef={editTextareaRef}
				handlers={handlers}
				partOpenState={partOpenState}
				onPartOpenChange={onPartOpenChange}
				phase={phase && line.id === lastStreamingAgentId ? phase : null}
			/>
		);
	};

	if (!virtualized) {
		return (
			<div className="flex w-full flex-col gap-6">
				{lines.map((line) => (
					<Fragment key={transcriptLineKey(line, activeTabId)}>
						{renderRow(line)}
					</Fragment>
				))}
			</div>
		);
	}

	return (
		<div
			className="relative w-full"
			style={{ height: rowVirtualizer.getTotalSize() }}
		>
			{rowVirtualizer.getVirtualItems().map((virtualRow) => (
				// pb-8 replaces the flex gap-8 spacing (absolute rows have no gap).
				<div
					key={virtualRow.key}
					className="absolute top-0 left-0 w-full pb-6"
					style={{ transform: `translateY(${virtualRow.start}px)` }}
					ref={rowVirtualizer.measureElement}
					data-index={virtualRow.index}
				>
					{renderRow(lines[virtualRow.index])}
				</div>
			))}
		</div>
	);
}

export function ChatTranscript({
	lines,
	activeTabId,
	hydratingSessionId,
	compact = false,
	forceVirtualize = false,
	activeTabIsRunning,
	submitting,
	switching,
	editingLineId,
	editingText,
	editTextareaRef,
	editCompositionProps,
	isEditBlockedByIme,
	onEditingTextChange,
	onCancelEditing,
	onResendEdited,
	onStartEditing,
	onOpenSource,
	phase = null,
	welcomeTitle,
}: {
	lines: ChatLine[];
	activeTabId: string;
	hydratingSessionId: string | null;
	compact?: boolean;
	/** Storybook / tests: windowed rendering even below the line threshold. */
	forceVirtualize?: boolean;
	activeTabIsRunning: boolean;
	submitting: boolean;
	switching: boolean;
	editingLineId: string | null;
	editingText: string;
	editTextareaRef: RefObject<HTMLTextAreaElement | null>;
	editCompositionProps: {
		onCompositionStart?: () => void;
		onCompositionEnd?: () => void;
	};
	isEditBlockedByIme: (event: ImeGuardEvent) => boolean;
	onEditingTextChange: (text: string) => void;
	onCancelEditing: () => void;
	onResendEdited: (lineId: string) => void;
	onStartEditing: (lineId: string, text: string) => void;
	/** Open a vault path / paper (or external URL) from Sources / inline citation. */
	onOpenSource?: (source: string) => void;
	/** Loading phase of the in-flight turn (starting / waiting-model / reconnecting). */
	phase?: AgentPhaseState | null;
	welcomeTitle?: string;
}) {
	const { t } = useTranslation("agent");
	const restoringHistorySession =
		hydratingSessionId === activeTabId && lines.length === 0;
	const showWelcome =
		lines.length === 0 &&
		!hydratingSessionId &&
		!activeTabIsRunning &&
		!submitting &&
		!switching;

	// Lifted Reasoning/Tool/Plan open state so virtualized rows keep their
	// fold state across unmount/remount. Keyed by `${rowKey}:${part.id}`.
	const [partOpenState, setPartOpenState] = useState<Record<string, boolean>>(
		{},
	);
	// Tab switch resets the table (non-agent line ids can collide across tabs).
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on tab switch
	useEffect(() => {
		setPartOpenState({});
	}, [activeTabId]);
	const handlePartOpenChange = useCallback((key: string, open: boolean) => {
		setPartOpenState((prev) =>
			prev[key] === open ? prev : { ...prev, [key]: open },
		);
	}, []);

	// Latest-callback ref + identity-stable wrappers: parents may pass inline
	// closures, but memoized rows must not re-render on every parent render.
	const latestHandlersRef = useRef<RowHandlers>({
		isEditBlockedByIme,
		onEditingTextChange,
		onCancelEditing,
		onResendEdited,
		onStartEditing,
		onOpenSource,
		editCompositionProps,
	});
	latestHandlersRef.current = {
		isEditBlockedByIme,
		onEditingTextChange,
		onCancelEditing,
		onResendEdited,
		onStartEditing,
		onOpenSource,
		editCompositionProps,
	};
	const hasOpenSource = Boolean(onOpenSource);
	const rowHandlers = useMemo<RowHandlers>(
		() => ({
			isEditBlockedByIme: (event) =>
				latestHandlersRef.current.isEditBlockedByIme(event),
			onEditingTextChange: (text) =>
				latestHandlersRef.current.onEditingTextChange(text),
			onCancelEditing: () => latestHandlersRef.current.onCancelEditing(),
			onResendEdited: (lineId) =>
				latestHandlersRef.current.onResendEdited(lineId),
			onStartEditing: (lineId, text) =>
				latestHandlersRef.current.onStartEditing(lineId, text),
			// Keep undefined when absent so rows preserve "no open handler" UI.
			onOpenSource: hasOpenSource
				? (source) => latestHandlersRef.current.onOpenSource?.(source)
				: undefined,
			editCompositionProps: {
				onCompositionStart: () =>
					latestHandlersRef.current.editCompositionProps.onCompositionStart?.(),
				onCompositionEnd: () =>
					latestHandlersRef.current.editCompositionProps.onCompositionEnd?.(),
			},
		}),
		[hasOpenSource],
	);

	return (
		<Conversation className="min-h-0 flex-1">
			<ConversationContent
				scrollClassName={
					compact
						? "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						: undefined
				}
			>
				<TabScrollToBottom activeTabId={activeTabId} />
				{restoringHistorySession ? (
					<HistorySessionShimmer />
				) : lines.length === 0 ? (
					activeTabIsRunning ? (
						<ConversationEmptyState>
							<Shimmer className="text-center text-sm">
								{t("empty.waiting")}
							</Shimmer>
						</ConversationEmptyState>
					) : null
				) : (
					<TranscriptBody
						lines={lines}
						activeTabId={activeTabId}
						activeTabIsRunning={activeTabIsRunning}
						submitting={submitting}
						switching={switching}
						editingLineId={editingLineId}
						editingText={editingText}
						editTextareaRef={editTextareaRef}
						handlers={rowHandlers}
						partOpenState={partOpenState}
						onPartOpenChange={handlePartOpenChange}
						forceVirtualize={forceVirtualize}
						phase={phase}
					/>
				)}
			</ConversationContent>
			<AnimatePresence initial={false}>
				{showWelcome ? (
					<AgentWelcome
						key="welcome"
						title={welcomeTitle || t("empty.workspace")}
					/>
				) : null}
			</AnimatePresence>
			<ConversationScrollButton />
		</Conversation>
	);
}
