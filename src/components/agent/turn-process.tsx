import {
	Brain,
	Check,
	ChevronRight,
	FilePen,
	FileText,
	FolderInput,
	Globe,
	Loader2,
	type LucideIcon,
	Search,
	SquareTerminal,
	Trash2,
	Wrench,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type ReactNode,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentThinkingOrb } from "@/components/agent/agent-thinking-orb";
import { MessageResponse } from "@/components/ai-elements/message";
import {
	Plan,
	PlanAction,
	PlanContent,
	PlanDescription,
	PlanHeader,
	PlanStep,
	PlanTitle,
	PlanTrigger,
} from "@/components/ai-elements/plan";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ObjectIcon } from "@/components/icons/object-icon";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useSettings } from "@/hooks/use-app-stores";
import type { AgentPhaseState } from "@/lib/agent/api";
import {
	type AgentPart,
	isPendingAskUserToolStatus,
	parseAskUserQuestions,
	type ToolUiState,
} from "@/lib/agent/chat-state";
import { contextPathIconKind } from "@/lib/agent/context-path-icon";
import {
	describeTool,
	describeToolRun,
	formatDuration,
	groupProcessParts,
	streamingLabel,
	summarizeTools,
	type ToolCategory,
	toolCategory,
	toolFilePaths,
} from "@/lib/agent/tool-activity";
import { cn } from "@/lib/core/utils";
import { openAgentFile } from "@/lib/workspace/actions";

const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
	read: FileText,
	edit: FilePen,
	delete: Trash2,
	move: FolderInput,
	search: Search,
	execute: SquareTerminal,
	fetch: Globe,
	think: Brain,
	other: Wrench,
};

type OpenState = {
	partOpenState: Record<string, boolean>;
	onPartOpenChange: (key: string, open: boolean) => void;
};

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(listener: () => void) {
	const media = window.matchMedia(reducedMotionQuery);
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}
const prefersReducedMotion = () =>
	window.matchMedia(reducedMotionQuery).matches;

/**
 * Live status while a turn runs: what the agent is doing right now in plain
 * words (the label slides when it changes) and how long the turn has run.
 * Elapsed time comes from the turn's start stamp, so it survives remounts.
 */
export function StreamingActivityRow({
	parts,
	phase = null,
	startedAt,
}: {
	parts: AgentPart[];
	/** Backend loading phase (starting / waiting-model / reconnecting) outranks part-derived labels. */
	phase?: AgentPhaseState | null;
	startedAt?: number;
}) {
	const { t } = useTranslation("agent");
	const [mountedAt] = useState(() => Date.now());
	const origin = startedAt ?? mountedAt;
	const [now, setNow] = useState(() => Date.now());
	const reduceMotion = useSyncExternalStore(
		subscribeReducedMotion,
		prefersReducedMotion,
		() => true,
	);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	const elapsed = Math.max(0, Math.floor((now - origin) / 1000));
	const label = streamingLabel(
		phase,
		parts,
		t,
		reduceMotion ? 0 : Math.floor(elapsed / 8),
	);

	return (
		<div className="flex w-full items-center gap-2 text-muted-foreground text-sm">
			<AgentThinkingOrb
				parts={parts}
				streaming
				phase={phase}
				showLabel={false}
			/>
			<span className="relative min-w-0 flex-1 overflow-hidden">
				<AnimatePresence mode="popLayout" initial={false}>
					<motion.span
						key={label}
						className="block truncate"
						initial={reduceMotion ? false : { opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
						transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
					>
						{reduceMotion ? (
							label
						) : (
							<Shimmer as="span" duration={2.4} className="block truncate">
								{label}
							</Shimmer>
						)}
					</motion.span>
				</AnimatePresence>
			</span>
			<span className="text-xs tabular-nums">
				{t("streaming.elapsed", { count: elapsed })}
			</span>
		</div>
	);
}

/**
 * A finished turn's work as one quiet line ("Worked for 42 s · Read 5 files ·
 * Searched twice"); the steps open on click, in the order they happened.
 */
export function TurnWorkSummary({
	rowKey,
	process,
	durationMs,
	partOpenState,
	onPartOpenChange,
	onOpenSource,
}: OpenState & {
	rowKey: string;
	process: AgentPart[];
	durationMs?: number;
	onOpenSource?: (source: string) => void;
}) {
	const { t } = useTranslation("agent");
	const showTechnicalDetails = useSettings((state) => state.developerMode);
	const key = `${rowKey}:__process__`;
	const open = partOpenState[key] ?? false;
	const tools = process.flatMap((part) =>
		part.type === "tool" ? [part.tool] : [],
	);
	const failed = tools.some((tool) => tool.status === "failed");
	const label = [
		durationMs !== undefined
			? t("activity.summary", { duration: formatDuration(durationMs, t) })
			: null,
		summarizeTools(tools, t) || null,
	]
		.filter(Boolean)
		.join(" · ");

	// Keep protocol data in the transcript for recovery/diagnostics; normal
	// conversations expose outcomes, not shell commands or internal reasoning.
	if (!showTechnicalDetails)
		return (
			<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<span>
					{durationMs !== undefined
						? t("activity.summary", { duration: formatDuration(durationMs, t) })
						: t("activity.finished")}
				</span>
				{failed ? (
					<span className="text-destructive">{t("activity.incomplete")}</span>
				) : null}
			</div>
		);

	return (
		<Collapsible
			open={open}
			onOpenChange={(next) => onPartOpenChange(key, next)}
			className="not-prose w-full"
		>
			<CollapsibleTrigger className="group -ml-1.5 flex max-w-full items-center gap-1.5 rounded-full px-1.5 py-0.5 text-left text-muted-foreground text-xs transition-colors hover:bg-muted/70 hover:text-foreground">
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 transition-transform",
						open && "rotate-90",
					)}
					aria-hidden
				/>
				<span className="truncate">{label || t("activity.verb.think")}</span>
				{failed ? (
					<X className="size-3 shrink-0 text-destructive" aria-hidden />
				) : null}
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-1.5 flex flex-col gap-0.5 border-hairline-soft border-l pl-3">
					<ProcessSteps
						rowKey={rowKey}
						process={process}
						partOpenState={partOpenState}
						onPartOpenChange={onPartOpenChange}
						onOpenSource={onOpenSource}
					/>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ProcessSteps({
	rowKey,
	process,
	partOpenState,
	onPartOpenChange,
	onOpenSource,
}: OpenState & {
	rowKey: string;
	process: AgentPart[];
	onOpenSource?: (source: string) => void;
}) {
	const { t } = useTranslation("agent");
	return groupProcessParts(process).map((item) => {
		if (item.type === "tools") {
			const key = `${rowKey}:${item.key}`;
			return item.tools.length === 1 ? (
				<ToolCallRow
					key={key}
					openKey={key}
					tool={item.tools[0] as ToolUiState}
					partOpenState={partOpenState}
					onPartOpenChange={onPartOpenChange}
				/>
			) : (
				<ToolRunRow
					key={key}
					rowKey={rowKey}
					runKey={key}
					tools={item.tools}
					partOpenState={partOpenState}
					onPartOpenChange={onPartOpenChange}
				/>
			);
		}
		const part = item.part;
		const key = `${rowKey}:${part.id}`;
		if (part.type === "text") {
			if (!part.text.trim()) return null;
			// Narration between tool calls ("Let me check the method…").
			return (
				<div key={key} className="py-0.5 text-muted-foreground text-xs">
					<MessageResponse onOpenSource={onOpenSource}>
						{part.text}
					</MessageResponse>
				</div>
			);
		}
		if (part.type === "reasoning") {
			if (!part.text.trim()) return null;
			return (
				<Reasoning
					key={key}
					className="mb-0"
					isStreaming={false}
					defaultOpen={false}
					open={partOpenState[key] ?? false}
					onOpenChange={(open) => onPartOpenChange(key, open)}
				>
					{/* Same row style as tool steps: icon + plain label. */}
					<ReasoningTrigger className="gap-1.5 py-0.5 text-xs">
						<Brain className="size-3.5 shrink-0" aria-hidden />
						<span className="truncate">{t("activity.verb.think")}</span>
					</ReasoningTrigger>
					<ReasoningContent className="mt-1 pb-1" onOpenSource={onOpenSource}>
						{part.text}
					</ReasoningContent>
				</Reasoning>
			);
		}
		const plan = part.entries;
		if (plan.length === 0) return null;
		return (
			<Plan
				key={key}
				className="mb-0 rounded-none border-0 bg-transparent shadow-none"
				isStreaming={false}
				open={partOpenState[key] ?? false}
				onOpenChange={(open) => onPartOpenChange(key, open)}
			>
				<PlanHeader className="px-0 py-1">
					<div className="min-w-0 flex-1">
						<PlanTitle className="text-xs">{t("plan.title")}</PlanTitle>
						<PlanDescription className="text-xs">
							{t("plan.steps", {
								completed: plan.filter((p) => p.status === "completed").length,
								total: plan.length,
							})}
						</PlanDescription>
					</div>
					<PlanAction>
						<PlanTrigger />
					</PlanAction>
				</PlanHeader>
				<PlanContent className="px-0 pt-0 pb-1">
					<ol className="space-y-1.5">
						{plan.map((entry) => (
							<PlanStep
								key={`${entry.status}:${entry.priority}:${entry.content}`}
								status={
									entry.status === "completed"
										? "completed"
										: entry.status === "in_progress"
											? "in_progress"
											: "pending"
								}
							>
								{entry.content}
							</PlanStep>
						))}
					</ol>
				</PlanContent>
			</Plan>
		);
	});
}

function StatusIcon({ status }: { status: ToolUiState["status"] }) {
	if (status === "pending" || status === "in_progress") {
		return <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />;
	}
	if (status === "failed") {
		return <X className="size-3 shrink-0 text-destructive" aria-hidden />;
	}
	return <Check className="size-3 shrink-0 opacity-60" aria-hidden />;
}

function StepTrigger({
	icon: Icon,
	open,
	children,
	status,
}: {
	icon: LucideIcon;
	open: boolean;
	children: ReactNode;
	status: ToolUiState["status"];
}) {
	return (
		<CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 text-left text-muted-foreground text-xs transition-colors hover:text-foreground">
			<Icon className="size-3.5 shrink-0" aria-hidden />
			<span className="min-w-0 truncate">{children}</span>
			<StatusIcon status={status} />
			<ChevronRight
				className={cn(
					"size-3 shrink-0 opacity-0 transition-[transform,opacity] group-hover:opacity-60",
					open && "rotate-90 opacity-60",
				)}
				aria-hidden
			/>
		</CollapsibleTrigger>
	);
}

/** Overall status of several calls: running wins, then failure. */
function runStatus(tools: ToolUiState[]): ToolUiState["status"] {
	if (tools.some((t) => t.status === "pending" || t.status === "in_progress")) {
		return "in_progress";
	}
	return tools.some((t) => t.status === "failed") ? "failed" : "completed";
}

/** Consecutive same-kind calls ("Read 5 files") that open into one row each. */
function ToolRunRow({
	rowKey,
	runKey,
	tools,
	partOpenState,
	onPartOpenChange,
}: OpenState & { rowKey: string; runKey: string; tools: ToolUiState[] }) {
	const { t } = useTranslation("agent");
	const open = partOpenState[runKey] ?? false;
	const first = tools[0] as ToolUiState;
	return (
		<Collapsible
			open={open}
			onOpenChange={(next) => onPartOpenChange(runKey, next)}
		>
			<StepTrigger
				icon={CATEGORY_ICON[toolCategory(first)]}
				open={open}
				status={runStatus(tools)}
			>
				{describeToolRun(tools, t)}
			</StepTrigger>
			<CollapsibleContent>
				<div className="flex flex-col gap-0.5 pl-5">
					{tools.map((tool) => (
						<ToolCallRow
							key={tool.id}
							openKey={`${rowKey}:tool:${tool.id}`}
							tool={tool}
							partOpenState={partOpenState}
							onPartOpenChange={onPartOpenChange}
						/>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

const FILE_CATEGORIES: ToolCategory[] = ["read", "edit", "move", "delete"];
const isFileTool = (tool: ToolUiState) =>
	FILE_CATEGORIES.includes(toolCategory(tool));
const fileName = (path: string) =>
	path
		.replace(/[\\/]+$/, "")
		.split(/[\\/]/)
		.pop() || path;

/** A call's files as links that open them (Vault tab, else the file manager). */
function FileLinks({ paths }: { paths: string[] }) {
	if (!paths.length) return null;
	return (
		<div className="flex flex-col items-start gap-0.5">
			{paths.map((path) => (
				<button
					key={path}
					type="button"
					title={path}
					className="max-w-full truncate rounded-sm text-left font-mono text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					onClick={() => openAgentFile(path)}
				>
					{path}
				</button>
			))}
		</div>
	);
}

/**
 * Files this turn wrote, under the answer: one click opens each (HTML in the
 * local preview, Markdown in the editor, …).
 */
export function ProducedFiles({ paths }: { paths: string[] }) {
	const { t } = useTranslation("agent");
	if (!paths.length) return null;
	return (
		<ul
			className="flex flex-wrap gap-1.5"
			aria-label={t("activity.producedFiles")}
		>
			{paths.map((path) => {
				return (
					<li key={path} className="min-w-0 max-w-full">
						<button
							type="button"
							title={path}
							className="flex max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs transition-colors duration-100 hover:bg-accent"
							onClick={() => openAgentFile(path)}
						>
							<ObjectIcon
								kind={contextPathIconKind(path)}
								className="size-3.5 shrink-0"
							/>
							<span className="truncate">{fileName(path)}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** One call as a phrase; raw input / output only on demand. */
function ToolCallRow({
	openKey,
	tool,
	partOpenState,
	onPartOpenChange,
}: OpenState & { openKey: string; tool: ToolUiState }) {
	const { t } = useTranslation("agent");
	const open = partOpenState[openKey] ?? false;
	const askPending =
		Boolean(parseAskUserQuestions(tool.input)) &&
		isPendingAskUserToolStatus(tool.status);
	return (
		<Collapsible
			open={open}
			onOpenChange={(next) => onPartOpenChange(openKey, next)}
		>
			<StepTrigger
				icon={CATEGORY_ICON[toolCategory(tool)]}
				open={open}
				status={tool.status}
			>
				{describeTool(tool, t)}
			</StepTrigger>
			<CollapsibleContent>
				{askPending ? (
					<p className="py-1 pl-5 text-muted-foreground text-xs">
						{t("askUserQuestion.pendingInComposer")}
					</p>
				) : (
					<div className="flex flex-col gap-1.5 py-1 pl-5">
						{isFileTool(tool) ? (
							<FileLinks paths={toolFilePaths(tool)} />
						) : null}
						<ToolPayload label={t("activity.input")} value={tool.input} />
						<ToolPayload label={t("activity.output")} value={tool.output} />
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Raw text of a payload; unwraps `{ output: "…" }`-style single-text wrappers. */
function payloadText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const entries = Object.entries(value);
		const [only] = entries;
		if (entries.length === 1 && typeof only?.[1] === "string") return only[1];
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Plain monospace dump — no syntax highlighter per call. */
function ToolPayload({ label, value }: { label: string; value: unknown }) {
	if (value === undefined || value === null || value === "") return null;
	return (
		<div className="min-w-0">
			<p className="mb-0.5 text-caption text-muted-foreground uppercase tracking-wide">
				{label}
			</p>
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2 py-1.5 font-mono text-caption leading-relaxed">
				{payloadText(value)}
			</pre>
		</div>
	);
}
