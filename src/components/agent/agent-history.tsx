import { History, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isSessionIdPrefixTitle } from "@/components/agent/hooks/use-agent-history";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import type { ChatLine, ChatSessionHistoryItem } from "@/lib/agent/chat-state";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import { cn } from "@/lib/core/utils";

/** "10 分钟前" / "昨天" within a week, a short date after that. */
function historyTime(value: string, language: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const seconds = (date.getTime() - Date.now()) / 1000;
	const steps: [Intl.RelativeTimeFormatUnit, number][] = [
		["minute", 60],
		["hour", 3600],
		["day", 86400],
	];
	if (Math.abs(seconds) < 60) {
		return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
			0,
			"second",
		);
	}
	if (Math.abs(seconds) < 7 * 86400) {
		const [unit, size] =
			[...steps].reverse().find(([, step]) => Math.abs(seconds) >= step) ??
			steps[0];
		return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
			Math.round(seconds / size),
			unit,
		);
	}
	return new Intl.DateTimeFormat(language, {
		month: "short",
		day: "numeric",
	}).format(date);
}

export function HistorySessionList({
	sessionHistory,
	activeTabId,
	submitting,
	onOpen,
	onDelete,
	loading = false,
}: {
	sessionHistory: ChatSessionHistoryItem[];
	activeTabId: string;
	submitting: boolean;
	onOpen: (item: ChatSessionHistoryItem) => void;
	onDelete?: (item: ChatSessionHistoryItem) => void;
	loading?: boolean;
}) {
	const { t, i18n } = useTranslation("agent");

	if (sessionHistory.length === 0) {
		return (
			<p className="px-3 py-4 text-muted-foreground text-sm leading-none">
				{t(loading ? "history.restoring" : "history.empty")}
			</p>
		);
	}

	return (
		<div className="max-h-72 overflow-y-auto p-1.5">
			{sessionHistory.map((item) => {
				const isActive = item.id === activeTabId;
				const firstUserLine = item.lines.find(
					(line): line is Extract<ChatLine, { kind: "user" }> =>
						line.kind === "user",
				);
				// Ignore historical session-id placeholders so user-prompt
				// fallback / hydration can surface (#484, Kimi `ses_…`).
				const providerId = item.providerSessionId?.trim() || "";
				const storedTitle =
					isSessionIdPrefixTitle(item.title, item.id) ||
					(providerId !== "" && isSessionIdPrefixTitle(item.title, providerId))
						? ""
						: item.title;
				const label = displayHistoryTitle(
					storedTitle || firstUserLine?.text || "",
					item.id.slice(0, 8),
				);
				return (
					<div
						key={item.id}
						className="group/history flex items-center rounded-md hover:bg-muted/70 focus-within:bg-muted/70"
					>
						<button
							key={item.id}
							type="button"
							disabled={submitting}
							className={cn(
								"flex min-w-0 flex-1 flex-col gap-1 rounded-md px-2 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
								isActive
									? "bg-muted text-foreground"
									: "hover:bg-muted/70 focus-visible:bg-muted/70",
							)}
							onClick={() => onOpen(item)}
						>
							<span className="line-clamp-2 text-sm leading-snug">{label}</span>
							{/* The list is already per-agent, so only status + when. */}
							<span className="flex items-center gap-1.5 text-muted-foreground text-xs leading-none">
								{item.status === "running" ? (
									<span
										className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
										aria-hidden
									/>
								) : null}
								{t(`history.status.${item.status}`)}
								{historyTime(item.startedAt, i18n.language) ? (
									<> · {historyTime(item.startedAt, i18n.language)}</>
								) : null}
							</span>
						</button>
						{onDelete && (
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className="mr-1 size-11 shrink-0 text-muted-foreground hover:text-destructive sm:size-6"
								aria-label={t("history.delete")}
								title={t("history.delete")}
								disabled={submitting || item.status === "running"}
								onClick={() => onDelete(item)}
							>
								<Trash2 className="size-3.5" />
							</Button>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Sidebar-mode header: new chat + history popover (+ optional actions). */
export function SidebarHistoryTrailing({
	historyOpen,
	onHistoryOpenChange,
	sessionHistory,
	activeTabId,
	submitting,
	headerActions,
	onNewConversation,
	onOpenSession,
	onDeleteSession,
	historyLoading = false,
}: {
	historyOpen: boolean;
	onHistoryOpenChange: (open: boolean) => void;
	sessionHistory: ChatSessionHistoryItem[];
	activeTabId: string;
	submitting: boolean;
	headerActions?: ReactNode;
	onNewConversation: () => void;
	onOpenSession: (item: ChatSessionHistoryItem) => void;
	onDeleteSession?: (item: ChatSessionHistoryItem) => void;
	historyLoading?: boolean;
}) {
	const { t } = useTranslation("agent");

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				aria-label={t("tabs.new")}
				title={t("tabs.new")}
				disabled={submitting}
				onClick={onNewConversation}
			>
				<Plus className="size-4" />
			</Button>
			<Popover open={historyOpen} onOpenChange={onHistoryOpenChange}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-1.5 font-normal text-muted-foreground text-sm leading-none hover:text-foreground"
						aria-label={t("history.aria")}
						title={t("history.label")}
						disabled={submitting}
					>
						<History className="size-3.5" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-80 p-0">
					<PopoverHeader className="border-b px-3 py-2">
						<PopoverTitle className="font-medium text-sm leading-none">
							{t("history.title")}
						</PopoverTitle>
						<PopoverDescription className="text-muted-foreground text-sm leading-snug">
							{t("history.description")}
						</PopoverDescription>
					</PopoverHeader>
					<HistorySessionList
						loading={historyLoading}
						sessionHistory={sessionHistory}
						activeTabId={activeTabId}
						submitting={submitting}
						onOpen={onOpenSession}
						onDelete={onDeleteSession}
					/>
				</PopoverContent>
			</Popover>
			{headerActions}
		</>
	);
}
