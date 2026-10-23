"use client";

/**
 * One review comment card in the column: quote, body, replies and the
 * lifecycle actions (reply / edit / resolve / reopen / delete / restore).
 * Editing is inline — textarea + ⌘/Ctrl+Enter to save, Esc to cancel — the
 * same idiom as the PDF comment cards. Replies also get explicit buttons,
 * since a plain Enter only breaks the line. The author edits their own
 * replies the same way and may delete any reply (after a confirm, as it
 * cannot be undone).
 */

import {
	MessageSquare,
	MessageSquareCheck,
	Pencil,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CommentReply, ReviewComment } from "@/lib/core/bindings";
import { cn } from "@/lib/core/utils";
import { type AgentHue, agentStyle } from "@/lib/review/agents";
import {
	requestRevealComment,
	selectComment,
	setActiveComment,
} from "@/lib/review/store";

type CommentCardProps = {
	comment: ReviewComment;
	active?: boolean;
	/** Picked by the user: shown in full. Others stay compact so a column of
	 * many comments keeps each card near its text. */
	selected?: boolean;
	/** Arrived from AI since the user last looked. */
	isNew?: boolean;
	/** Each Agent's color, so its cards and replies match its revisions. */
	hues?: ReadonlyMap<string, AgentHue>;
	onAction: (
		commentId: string,
		action: "reply" | "edit" | "resolve" | "reopen" | "delete" | "restore",
		body?: string,
		expectedUpdatedAt?: string,
		/** Act on this reply instead: `edit` or `delete`. */
		replyId?: string,
	) => Promise<boolean>;
};

const iconButton =
	"flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function onAreaKeyDown(
	event: React.KeyboardEvent<HTMLTextAreaElement>,
	submit: () => void,
	cancel: () => void,
) {
	if (event.nativeEvent.isComposing) return;
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		submit();
	}
	if (event.key === "Escape") {
		event.preventDefault();
		cancel();
	}
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export const CommentCard = memo(function CommentCard({
	comment,
	active = false,
	selected = false,
	isNew = false,
	hues,
	onAction,
}: CommentCardProps) {
	const { t } = useTranslation(["review", "common"]);
	const [editing, setEditing] = useState(false);
	const [editingBusy, setEditingBusy] = useState(false);
	const [replying, setReplying] = useState(false);
	const [text, setText] = useState(comment.body);
	const editVersionRef = useRef(comment.updatedAt);
	const [replyText, setReplyText] = useState("");
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const deleted = comment.status === "deleted";
	const resolved = comment.status === "resolved";
	const outdated = comment.source !== "pdf" && comment.anchor === "deleted";
	const isAgent = comment.actor === "agent";
	const hueOf = (agent?: string | null) =>
		agent ? hues?.get(agent) : undefined;
	const open = selected || editing || replying;
	// Whether the card was open before this press: the press itself opens it,
	// and only a click on an already open card edits its text.
	const openBeforePress = useRef(open);

	useEffect(() => {
		if (editing || replying) areaRef.current?.focus();
	}, [editing, replying]);

	const submitEdit = async () => {
		if (editingBusy) return;
		const body = text.trim();
		if (!body) return;
		if (body && body !== comment.body) {
			setEditingBusy(true);
			const ok = await onAction(
				comment.id,
				"edit",
				body,
				editVersionRef.current,
			);
			setEditingBusy(false);
			if (!ok) return;
		}
		setEditing(false);
	};
	const [sending, setSending] = useState(false);
	const cancelReply = () => {
		setReplyText("");
		setReplying(false);
	};
	const submitReply = async () => {
		const body = replyText.trim();
		if (!body || sending) return;
		setSending(true);
		// Keep the draft when the reply fails; the error shows as a toast.
		const ok = await onAction(comment.id, "reply", body);
		setSending(false);
		if (ok) cancelReply();
	};

	return (
		<article
			className={cn(
				"relative rounded-lg border bg-card p-4 text-sm transition-colors",
				isNew && "ring-ring ring-1",
				(active || selected) && "border-ring",
				resolved && "opacity-75",
				deleted && "opacity-60",
			)}
			data-review-actor={isAgent ? "agent" : "author"}
			data-review-comment-id={comment.id}
			style={agentStyle(isAgent ? hueOf(comment.agent) : undefined)}
			// Pointer or keyboard focus inside the card picks it.
			onFocus={() => selectComment(comment.id)}
			onKeyDownCapture={() => {
				openBeforePress.current = open;
			}}
			onPointerDown={() => {
				openBeforePress.current = open;
				selectComment(comment.id);
			}}
			onMouseEnter={() => setActiveComment(comment.id)}
			onMouseLeave={() => setActiveComment(null)}
		>
			<div className="mb-3 flex items-center gap-2 text-xs">
				<MessageSquare
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden
				/>
				<span
					className={cn(
						"min-w-0 flex-1 truncate font-medium",
						isAgent ? "text-(--agent)" : "text-foreground",
					)}
				>
					{isAgent ? (comment.agent ?? t("card.agent")) : t("card.author")}
				</span>
				<time
					className="shrink-0 text-muted-foreground tabular-nums"
					dateTime={comment.createdAt}
					title={formatTime(comment.createdAt)}
				>
					{new Date(comment.createdAt).toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					})}
				</time>
			</div>
			<button
				className="block w-full cursor-pointer rounded-md bg-muted/60 px-2.5 py-2 text-left text-muted-foreground text-xs leading-relaxed transition-colors hover:bg-accent"
				onClick={() => requestRevealComment(comment.id)}
				title={comment.quote}
				type="button"
			>
				<span className={open ? "line-clamp-2" : "line-clamp-1"}>
					{comment.quote}
				</span>
			</button>

			{open && comment.heading ? (
				<div className="mt-1 truncate text-[11px] text-muted-foreground/80">
					{comment.heading}
				</div>
			) : null}
			{outdated ? (
				<span className="ml-1 inline-flex rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
					{t("card.outdated")}
				</span>
			) : null}
			{!isAgent && comment.editedBy === "agent" ? (
				<span className="mt-1 inline-flex rounded-sm bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand">
					{t("card.editedByAgent")}
				</span>
			) : null}
			{isAgent && comment.editedBy === "author" ? (
				<span className="ml-1 text-xs text-muted-foreground">
					{t("card.editedByAuthor")}
				</span>
			) : null}

			{editing ? (
				<div>
					<textarea
						className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) =>
							onAreaKeyDown(
								e,
								() => void submitEdit(),
								() => {
									setText(comment.body);
									setEditing(false);
								},
							)
						}
						ref={areaRef}
						rows={3}
						value={text}
						disabled={editingBusy}
					/>
					<div className="mt-2 flex justify-end gap-2">
						<button
							type="button"
							className="h-7 rounded-md px-2 text-muted-foreground text-xs hover:bg-accent disabled:opacity-40"
							disabled={editingBusy}
							onClick={() => {
								setText(comment.body);
								setEditing(false);
							}}
						>
							{t("composer.cancel")}
						</button>
						<button
							type="button"
							className="h-7 rounded-md bg-primary px-3 text-primary-foreground text-xs disabled:opacity-40"
							disabled={editingBusy || !text.trim()}
							onClick={() => void submitEdit()}
						>
							{t("common:save")}
						</button>
					</div>
				</div>
			) : (
				<button
					className={cn(
						"mt-3 block w-full whitespace-pre-wrap text-left leading-relaxed",
						!open && "line-clamp-3",
					)}
					onClick={() => {
						// A compact card opens first; the open one edits.
						if (deleted || !openBeforePress.current) return;
						setText(comment.body);
						editVersionRef.current = comment.updatedAt;
						setEditing(true);
					}}
					type="button"
				>
					{comment.body}
				</button>
			)}

			{!open && comment.replies?.length ? (
				<div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
					{t("card.replyCount", { count: comment.replies.length })}
				</div>
			) : null}
			{(open ? comment.replies : [])?.map((reply) => (
				<ReplyItem
					deletable={!deleted}
					editable={!deleted && reply.actor === "author"}
					hue={hueOf(reply.agent)}
					key={reply.id}
					onChange={(action, body, expectedVersion) =>
						onAction(comment.id, action, body, expectedVersion, reply.id)
					}
					reply={reply}
					threadVersion={comment.updatedAt}
				/>
			))}

			{replying ? (
				<>
					<textarea
						className="mt-2 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
						onChange={(e) => setReplyText(e.target.value)}
						onKeyDown={(e) =>
							onAreaKeyDown(e, () => void submitReply(), cancelReply)
						}
						placeholder={t("card.replyPlaceholder")}
						ref={editing ? undefined : areaRef}
						rows={2}
						value={replyText}
					/>
					<div className="mt-1.5 flex justify-end gap-1.5">
						<button
							className="h-6 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-accent"
							onClick={cancelReply}
							type="button"
						>
							{t("composer.cancel")}
						</button>
						<button
							className="h-6 rounded-md bg-primary px-2.5 text-primary-foreground text-xs transition-colors disabled:opacity-50"
							disabled={!replyText.trim() || sending}
							onClick={() => void submitReply()}
							type="button"
						>
							{t("card.reply")}
						</button>
					</div>
				</>
			) : null}

			<div
				className={cn("mt-2 items-center gap-0.5", open ? "flex" : "hidden")}
			>
				<span className="flex-1" />
				{!deleted ? (
					<>
						<button
							aria-label={t("card.reply")}
							className={iconButton}
							onClick={() => setReplying((v) => !v)}
							title={t("card.reply")}
							type="button"
						>
							<MessageSquare size={13} />
						</button>
						<button
							aria-label={resolved ? t("card.reopen") : t("card.resolve")}
							className={iconButton}
							onClick={() =>
								onAction(
									comment.id,
									resolved ? "reopen" : "resolve",
									undefined,
									comment.updatedAt,
								)
							}
							title={resolved ? t("card.reopen") : t("card.resolve")}
							type="button"
						>
							{resolved ? (
								<RotateCcw size={13} />
							) : (
								<MessageSquareCheck size={13} />
							)}
						</button>
						<button
							aria-label={t("card.delete")}
							className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
							onClick={() =>
								onAction(comment.id, "delete", undefined, comment.updatedAt)
							}
							title={t("card.delete")}
							type="button"
						>
							<Trash2 size={13} />
						</button>
					</>
				) : (
					<button
						aria-label={t("card.restore")}
						className={iconButton}
						onClick={() =>
							onAction(comment.id, "restore", undefined, comment.updatedAt)
						}
						title={t("card.restore")}
						type="button"
					>
						<RotateCcw size={13} />
					</button>
				)}
			</div>
		</article>
	);
});

function ReplyItem({
	reply,
	threadVersion,
	hue,
	editable,
	deletable,
	onChange,
}: {
	reply: CommentReply;
	threadVersion: string;
	hue?: AgentHue;
	/** The author's own reply, in a live comment. */
	editable: boolean;
	/** The author may delete any reply in a live comment. */
	deletable: boolean;
	onChange: (
		action: "edit" | "delete",
		body: string | undefined,
		expectedVersion: string,
	) => Promise<boolean>;
}) {
	const { t } = useTranslation("review");
	const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
	const [text, setText] = useState(reply.body);
	const versionRef = useRef(threadVersion);
	const save = async () => {
		const body = text.trim();
		if (
			body &&
			body !== reply.body &&
			!(await onChange("edit", body, versionRef.current))
		)
			return;
		setMode("view");
	};
	return (
		<div className="group/reply relative mt-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs leading-relaxed">
			{mode === "edit" ? (
				<textarea
					// biome-ignore lint/a11y/noAutofocus: opened by the edit button.
					autoFocus
					className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
					onBlur={() => void save()}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) =>
						onAreaKeyDown(
							e,
							() => void save(),
							() => setMode("view"),
						)
					}
					rows={2}
					value={text}
				/>
			) : (
				<div className="whitespace-pre-wrap">{reply.body}</div>
			)}
			<div className="mt-0.5 flex items-center gap-0.5 text-[11px] text-muted-foreground tabular-nums">
				<span className="min-w-0 flex-1 truncate">
					{reply.actor === "agent" ? (
						<span className="text-(--agent)" style={agentStyle(hue)}>
							{`${reply.agent ?? t("card.agent")} · `}
						</span>
					) : null}
					{formatTime(reply.createdAt)}
					{reply.editedAt ? ` · ${t("card.replyEdited")}` : null}
				</span>
				{deletable && mode === "delete" ? (
					<>
						<button
							className="h-5 rounded-sm px-1.5 transition-colors hover:bg-accent"
							onClick={() => setMode("view")}
							type="button"
						>
							{t("composer.cancel")}
						</button>
						<button
							className="h-5 rounded-sm px-1.5 text-destructive transition-colors hover:bg-destructive/10"
							onClick={() =>
								void onChange("delete", undefined, versionRef.current)
							}
							type="button"
						>
							{t("card.delete")}
						</button>
					</>
				) : mode === "view" && (editable || deletable) ? (
					<span className="absolute top-1 right-1 flex rounded-sm bg-muted opacity-0 transition-opacity group-focus-within/reply:opacity-100 group-hover/reply:opacity-100">
						{editable ? (
							<button
								aria-label={t("card.editReply")}
								className={cn(iconButton, "h-5 w-5")}
								onClick={() => {
									setText(reply.body);
									versionRef.current = threadVersion;
									setMode("edit");
								}}
								title={t("card.editReply")}
								type="button"
							>
								<Pencil size={11} />
							</button>
						) : null}
						{deletable ? (
							<button
								aria-label={t("card.deleteReply")}
								className={cn(iconButton, "h-5 w-5 hover:text-destructive")}
								onClick={() => {
									versionRef.current = threadVersion;
									setMode("delete");
								}}
								title={t("card.deleteReply")}
								type="button"
							>
								<Trash2 size={11} />
							</button>
						) : null}
					</span>
				) : null}
			</div>
		</div>
	);
}
