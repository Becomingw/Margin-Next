/**
 * Composer UI state: context chips, @mention / $skill / /slash menus with
 * keyboard navigation, drag-drop path attach, ↑/↓ prompt recall, and the
 * cross-window composer seed.
 */
import {
	type Dispatch,
	type KeyboardEvent,
	type DragEvent as ReactDragEvent,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ComposerInlineInputHandle } from "@/components/agent/composer/composer-inline-input";
import {
	cleanSkillDisplayName,
	type QuickOption,
} from "@/components/agent/composer/composer-quick-menus";
import type { AgentPanelRefs } from "@/components/agent/hooks/use-agent-panel-context";
import {
	useSelectionStore,
	useVisualContextStore,
} from "@/hooks/use-app-stores";
import type { useSessionComposerState } from "@/hooks/use-session-composer-state";
import type { AgentSkill } from "@/lib/agent";
import type { ChatLine } from "@/lib/agent/chat-state";
import {
	appendMissingInlineTokens,
	encodeCommandToken,
	encodeMentionToken,
	encodeSelectionToken,
	encodeSkillToken,
	extractMentionPaths,
	extractSelectionTokens,
	extractSkillIds,
	plainTriggerSuffix,
	replaceTrailingTriggerWithToken,
} from "@/lib/agent/composer-inline-tokens";
import {
	subscribePendingAgentComposerPrompt,
	takePendingAgentComposerPrompt,
} from "@/lib/agent/composer-seed";
import {
	listenAgentAttachContext,
	subscribePendingAgentContextPaths,
	takePendingAgentContextPaths,
} from "@/lib/agent/context-attach";
import {
	contextPathDisplayName,
	normalizeContextPath,
} from "@/lib/agent/context-path-icon";
import {
	buildMentionCandidatePaths,
	filterMentionOptions,
	loadRecentMentionPaths,
	mentionParentPath,
	mentionPathHasChildren,
	pushRecentMentionPath,
} from "@/lib/agent/mention";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import { sameSelectionReference } from "@/lib/agent/selection-reference";
import {
	removeSelection,
	type SelectionContext,
} from "@/lib/agent/selection-store";
import {
	type AcpCommand,
	filterSlashCommands,
} from "@/lib/agent/slash-commands";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import {
	dataTransferLooksLikeImages,
	dataTransferLooksLikePdfs,
	dataTransferLooksLikeVaultMove,
	dataTransferTypes,
} from "@/lib/core/file-accept";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { toSafeDisposer } from "@/lib/core/tauri-events";
import {
	collectUserPromptTexts,
	nextHistoryIndexOnDown,
	nextHistoryIndexOnUp,
	shouldNavigateHistoryDown,
	shouldNavigateHistoryUp,
} from "@/lib/ui/prompt-recall";
import { SKILL_MANAGEMENT_PATH } from "@/lib/vault/agent-config-paths";
import { toVaultRelative } from "@/lib/wiki";
import { openTab } from "@/lib/workspace/actions";

export type UseAgentComposerOptions = {
	refs: Pick<
		AgentPanelRefs,
		| "promptHistoryAppliedRef"
		| "promptHistoryDraftRef"
		| "promptHistoryIndexRef"
		| "switchingRef"
	>;
	composer: ReturnType<typeof useSessionComposerState>;
	vaultPath: string | null;
	vaultMarkdownPaths: string[];
	vaultDirectoryPaths: string[];
	vaultPaperPaths: string[];
	selectedPaperTitle: string | null;
	selectedVaultPath: string | null;
	followSelectedFile?: boolean;
	selectionPaperPath?: string | null;
	paperPathSet: ReadonlySet<string>;
	labelForPath: (path: string) => string;
	mentionLabelsByPath: Map<string, string>;
	contextPaths: string[];
	currentFilePath: string | null;
	skills: AgentSkill[];
	acpCommandsByAgent: Record<string, AcpCommand[]>;
	selectedAgentId: string | null;
	lines: ChatLine[];
	activeTabIsRunning: boolean;
	cancelCurrentRun: () => Promise<void>;
};

export type AgentComposer = {
	composerMenuDismissed: boolean;
	setComposerMenuDismissed: Dispatch<SetStateAction<boolean>>;
	mentionActiveIndex: number;
	setMentionActiveIndex: Dispatch<SetStateAction<number>>;
	quickActiveIndex: number;
	setQuickActiveIndex: Dispatch<SetStateAction<number>>;
	currentFileLabel: string;
	mentionChipPaths: string[];
	selectionChips: SelectionContext[];
	visualDrafts: PdfVisualDraft[];
	removeContextPath: (path: string) => void;
	selectedSkills: AgentSkill[];
	showMentionMenu: boolean;
	mentionBrowseRoot: string | null;
	mentionOptions: string[];
	mentionCandidates: string[];
	leaveMentionFolder: () => void;
	enterMentionFolder: (path: string) => void;
	attachMention: (path: string) => void;
	showQuickMenu: boolean;
	quickOptions: QuickOption[];
	pickQuickOption: (option: QuickOption) => void;
	removeSkill: (skillId: string) => void;
	attachContextPaths: (rawPaths: string[]) => void;
	handleComposerDragOver: (e: ReactDragEvent) => void;
	handleComposerDrop: (e: ReactDragEvent) => void;
	handleComposerMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onComposerTextChangeFromUser: (text: string) => void;
	/** Ref to the inline input, used to insert selections at the caret. */
	composerInputRef: RefObject<ComposerInlineInputHandle | null>;
};

export function useAgentComposer({
	refs: {
		promptHistoryAppliedRef,
		promptHistoryDraftRef,
		promptHistoryIndexRef,
		switchingRef,
	},
	composer: {
		text: composerText,
		mentionedPaths,
		selectedSkillIds,
		setText: setComposerText,
		setIncludeSelectedFile,
		setMentionedPaths,
		setSelectedSkillIds,
		holdForNextSession,
	},
	vaultPath,
	vaultMarkdownPaths,
	vaultDirectoryPaths,
	vaultPaperPaths,
	selectedPaperTitle,
	selectedVaultPath,
	followSelectedFile = true,
	selectionPaperPath,
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
}: UseAgentComposerOptions): AgentComposer {
	const [composerMenuDismissed, setComposerMenuDismissed] = useState(false);
	const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
	const [quickActiveIndex, setQuickActiveIndex] = useState(0);

	// Doctor / Settings may seed the composer via a cross-window event.
	useEffect(() => {
		const apply = (text: string) => {
			const next = text.trim();
			if (!next) return;
			holdForNextSession(next);
			setComposerText(next);
			setComposerMenuDismissed(true);
		};
		const pending = takePendingAgentComposerPrompt();
		if (pending) apply(pending);
		return subscribePendingAgentComposerPrompt(apply);
	}, [setComposerText, holdForNextSession]);

	/** Same paper label mode as the file tree (settings); title fallback if meta missing. */
	const currentFileLabel = useMemo(() => {
		if (!currentFilePath) return "";
		const labeled = labelForPath(currentFilePath);
		if (labeled && labeled !== contextPathDisplayName(currentFilePath)) {
			return labeled;
		}
		const title = selectedPaperTitle?.trim();
		if (
			title &&
			currentFilePath === selectedVaultPath &&
			paperPathSet.has(normalizeContextPath(currentFilePath))
		) {
			return title;
		}
		return labeled || contextPathDisplayName(currentFilePath);
	}, [
		currentFilePath,
		labelForPath,
		paperPathSet,
		selectedPaperTitle,
		selectedVaultPath,
	]);

	// Re-attach when the focused document/paper changes (user can still remove via X).
	useEffect(() => {
		if (!selectedVaultPath || !followSelectedFile) return;
		setIncludeSelectedFile(true);
	}, [selectedVaultPath, setIncludeSelectedFile, followSelectedFile]);

	const mentionChipPaths = useMemo(
		() => contextPaths.filter((path) => path !== selectedVaultPath),
		[contextPaths, selectedVaultPath],
	);

	// Ref exposed to AgentComposer so it can be wired to ComposerInlineInput.
	const composerInputRef = useRef<ComposerInlineInputHandle>(null);

	// Only explicitly pinned selections (Add to chat / ⌘K / ⌘L) become chips.
	// Live drag-selection stays in the store so pinActiveSelection can freeze it,
	// but is never shown or auto-inserted into the composer.
	const pinnedSelections = useSelectionStore((s) => s.pinned);
	const selectionChips = pinnedSelections;

	// Inline-ify newly pinned selections at the composer caret, then drop them
	// from the ephemeral store. Visual drafts still use the round chip row.
	const latestComposerTextRef = useRef(composerText);
	latestComposerTextRef.current = composerText;
	useEffect(() => {
		if (!pinnedSelections.length) return;
		let observer: MutationObserver | undefined;
		const insert = () => {
			const input = composerInputRef.current;
			if (!input) return false;
			observer?.disconnect();
			const existing = extractSelectionTokens(latestComposerTextRef.current);
			const inserted: string[] = [];
			for (const selection of pinnedSelections) {
				if (
					selection.origin === "pdf" &&
					selectionPaperPath !== undefined &&
					selection.sourcePath !== "PDF" &&
					normalizeContextPath(selection.sourcePath) !==
						normalizeContextPath(selectionPaperPath ?? "")
				)
					continue;
				if (!existing.some((ref) => sameSelectionReference(ref, selection))) {
					const token = encodeSelectionToken(selection);
					input.insertAtCursor(token, true);
					inserted.push(token);
					existing.push(selection);
				}
				removeSelection(selection.id);
			}
			// Survive the conversation load that may follow opening the panel.
			if (inserted.length) holdForNextSession(inserted.join(" "));
			return true;
		};
		if (!insert()) {
			observer = new MutationObserver(insert);
			observer.observe(document.body, { childList: true, subtree: true });
		}
		return () => observer?.disconnect();
	}, [pinnedSelections, selectionPaperPath, holdForNextSession]);

	const allVisualDrafts = useVisualContextStore((s) => s.drafts);
	const visualDrafts = useMemo(
		() =>
			selectionPaperPath === undefined
				? allVisualDrafts
				: allVisualDrafts.filter(
						(draft) =>
							normalizeContextPath(draft.paperPath) ===
							normalizeContextPath(selectionPaperPath ?? ""),
					),
		[allVisualDrafts, selectionPaperPath],
	);

	// Markers count as atoms so `$` / `@` inside `{{s:…}}` / `{{m:…}}` stay inert.
	const triggerText = plainTriggerSuffix(composerText);
	const mentionMatch = triggerText.match(/(^|\s)@([^\s]*)$/);
	/** Raw @query (preserve case for display; matching is case-insensitive). */
	const mentionQueryRaw = mentionMatch?.[2] ?? "";
	const mentionQuery = mentionQueryRaw.toLocaleLowerCase();

	const mentionCandidates = useMemo(
		() =>
			buildMentionCandidatePaths({
				markdownPaths: vaultMarkdownPaths,
				directoryPaths: vaultDirectoryPaths,
				paperPaths: vaultPaperPaths,
			}),
		[vaultDirectoryPaths, vaultMarkdownPaths, vaultPaperPaths],
	);

	const [recentMentionPaths, setRecentMentionPaths] = useState<string[]>(() => {
		try {
			return loadRecentMentionPaths(
				typeof localStorage === "undefined" ? null : localStorage,
				vaultPath,
			);
		} catch {
			return [];
		}
	});

	/**
	 * In-folder browse for `@` menu (null = root: recents + shallow tree).
	 * Chevron on the right drills into directories; papers stay leaves.
	 */
	const [mentionBrowseRoot, setMentionBrowseRoot] = useState<string | null>(
		null,
	);

	// Reload recents when Vault changes; leave any open folder browser.
	useEffect(() => {
		try {
			setRecentMentionPaths(
				loadRecentMentionPaths(
					typeof localStorage === "undefined" ? null : localStorage,
					vaultPath,
				),
			);
		} catch {
			setRecentMentionPaths([]);
		}
		setMentionBrowseRoot(null);
	}, [vaultPath]);

	// Close folder browser when `@` is gone or the menu is dismissed.
	useEffect(() => {
		if (!mentionMatch || composerMenuDismissed) {
			setMentionBrowseRoot(null);
		}
	}, [composerMenuDismissed, mentionMatch]);

	const mentionOptions = useMemo(() => {
		if (!mentionMatch) return [];
		return filterMentionOptions({
			candidates: mentionCandidates,
			query: mentionQuery,
			exclude: contextPaths,
			recent: recentMentionPaths,
			labelsByPath: mentionLabelsByPath,
			browseRoot: mentionBrowseRoot,
			limit: 8,
		});
	}, [
		contextPaths,
		mentionBrowseRoot,
		mentionCandidates,
		mentionLabelsByPath,
		mentionMatch,
		mentionQuery,
		recentMentionPaths,
	]);

	const enterMentionFolder = useCallback((path: string) => {
		setMentionBrowseRoot(path);
		setMentionActiveIndex(0);
		setComposerMenuDismissed(false);
	}, []);

	const leaveMentionFolder = useCallback(() => {
		setMentionBrowseRoot((current) => {
			if (!current) return null;
			return mentionParentPath(current);
		});
		setMentionActiveIndex(0);
	}, []);

	// `/` lists skills and the agent's own commands together; `$` only skills.
	const quickMatch = triggerText.match(/(^|\s)([$/])([^\s]*)$/);
	const quickTrigger = quickMatch?.[2] ?? null;
	const quickQuery = quickMatch?.[3]?.toLocaleLowerCase() ?? "";
	const slashCommands = acpCommandsByAgent[selectedAgentId ?? ""] ?? [];
	const quickOptions = useMemo<QuickOption[]>(() => {
		if (!quickTrigger) return [];
		const skillOptions: QuickOption[] = skills
			.filter((skill) =>
				`${skill.id} ${skill.name} ${skill.description}`
					.toLocaleLowerCase()
					.includes(quickQuery),
			)
			.filter((skill) => !selectedSkillIds.includes(skill.id))
			.slice(0, 6)
			.map((skill) => ({ kind: "skill", skill }));
		// An agent that also advertises a skill as a command shows it once, as
		// the Edda skill (same behaviour on every agent).
		const skillNames = new Set(
			skills.map((skill) =>
				cleanSkillDisplayName(skill.id).toLocaleLowerCase(),
			),
		);
		const commandOptions: QuickOption[] =
			quickTrigger === "/"
				? filterSlashCommands(slashCommands, quickQuery)
						.filter(
							(command) => !skillNames.has(command.name.toLocaleLowerCase()),
						)
						.map((command) => ({ kind: "command", command }))
				: [];
		const matches = [...skillOptions, ...commandOptions];
		// A bare trigger always opens (with the manage shortcut); a query only
		// when it matches something, so paths like " /usr" stay quiet.
		if (matches.length === 0 && quickQuery) return [];
		return [...matches, { kind: "manage" }];
	}, [quickQuery, quickTrigger, selectedSkillIds, skills, slashCommands]);

	const showMentionMenu =
		!composerMenuDismissed &&
		Boolean(mentionMatch) &&
		(mentionOptions.length > 0 || mentionBrowseRoot != null);
	const showQuickMenu =
		!composerMenuDismissed && !showMentionMenu && quickOptions.length > 0;

	useEffect(() => {
		setMentionActiveIndex((index) =>
			mentionOptions.length
				? Math.max(0, Math.min(index, mentionOptions.length - 1))
				: 0,
		);
	}, [mentionOptions.length]);

	useEffect(() => {
		setQuickActiveIndex((index) =>
			quickOptions.length
				? Math.max(0, Math.min(index, quickOptions.length - 1))
				: 0,
		);
	}, [quickOptions.length]);

	const selectedSkills = useMemo(
		() =>
			selectedSkillIds
				.map((id) => skills.find((skill) => skill.id === id))
				.filter((skill): skill is AgentSkill => Boolean(skill)),
		[selectedSkillIds, skills],
	);

	/** Insert @mention token(s) at the trailing trigger / end of the draft. */
	const attachContextPaths = useCallback(
		(rawPaths: string[]) => {
			const normalized = rawPaths
				.map((p) => toVaultRelative(vaultPath, p.trim()))
				.filter((p) => p.length > 0);
			if (!normalized.length) return;
			// Remember for empty-`@` recent hints (per Vault).
			try {
				const storage =
					typeof localStorage === "undefined" ? null : localStorage;
				let recents: string[] = [];
				for (const path of normalized) {
					recents = pushRecentMentionPath(storage, vaultPath, path);
				}
				if (recents.length) setRecentMentionPaths(recents);
			} catch {
				// ignore quota / private mode
			}
			setComposerMenuDismissed(true);
			setComposerText((prev) => {
				let next = prev;
				for (const path of normalized) {
					const token = encodeMentionToken(path);
					if (next.includes(token)) continue;
					next = replaceTrailingTriggerWithToken(next, "mention", token);
				}
				setMentionedPaths(extractMentionPaths(next));
				return next;
			});
		},
		[setComposerText, setMentionedPaths, vaultPath],
	);

	const attachMention = useCallback(
		(path: string) => {
			attachContextPaths([path]);
			setMentionBrowseRoot(null);
		},
		[attachContextPaths],
	);

	const removeContextPath = (path: string) => {
		if (path === currentFilePath || path === selectedVaultPath) {
			setIncludeSelectedFile(false);
			return;
		}
		const token = encodeMentionToken(path);
		setComposerText((prev) => {
			const next = prev
				.split(token)
				.join("")
				.replace(/[ \t]{2,}/g, " ");
			setMentionedPaths(extractMentionPaths(next));
			return next;
		});
	};

	// Legacy drafts: paths/skills in state but not yet embedded as inline tokens.
	useEffect(() => {
		const next = appendMissingInlineTokens(
			composerText,
			mentionedPaths,
			selectedSkillIds,
		);
		if (next === composerText) return;
		setComposerText(next);
		setMentionedPaths(extractMentionPaths(next));
		setSelectedSkillIds(extractSkillIds(next));
	}, [
		composerText,
		mentionedPaths,
		selectedSkillIds,
		setComposerText,
		setMentionedPaths,
		setSelectedSkillIds,
	]);

	// File tree "Add to chat" → drop paths as context chips (same as @-mention).
	// Handles same-window (module pub/sub) and the singleton feature window
	// (Tauri event). Consumes one pending batch on mount.
	useEffect(() => {
		const pending = takePendingAgentContextPaths();
		if (pending) attachContextPaths(pending);
		const unsubscribe = subscribePendingAgentContextPaths(attachContextPaths);
		const unlisten = toSafeDisposer(
			listenAgentAttachContext(attachContextPaths),
		);
		return () => {
			unsubscribe();
			unlisten();
		};
	}, [attachContextPaths]);

	/**
	 * Drag from file tree sets `text/plain` vault paths (newline-separated).
	 * Capture as context chips instead of inserting raw path text into the textarea.
	 * Reuses the same chip UI as `@` mentions — not AI Elements Attachments
	 * (those are FileUIPart blobs; ACP context is path-based).
	 */
	const handleComposerDragOver = useCallback((e: ReactDragEvent) => {
		const types = dataTransferTypes(e.dataTransfer);
		if (!types.length) return;
		const hasText = types.includes("text/plain") || types.includes("Text");
		const hasFiles = types.includes("Files");
		// In-app file-tree drags stay path chips. OS file drops (often
		// text/plain path + Files) belong to PromptInput / image attach.
		if (
			dataTransferLooksLikeVaultMove(e.dataTransfer) ||
			(hasText && !hasFiles)
		) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		}
	}, []);

	const handleComposerDrop = useCallback(
		(e: ReactDragEvent) => {
			// PDF drops belong to the app-wide importer, even when the composer
			// receives a text/plain path alongside the file payload.
			if (
				!dataTransferLooksLikeVaultMove(e.dataTransfer) &&
				dataTransferLooksLikePdfs(e.dataTransfer)
			) {
				return;
			}
			// Finder / Preview / other-app image drops include text/plain paths
			// AND Files. Those belong to PromptInput, not @ context chips.
			// In-app tree moves always stay path chips.
			if (
				!dataTransferLooksLikeVaultMove(e.dataTransfer) &&
				dataTransferLooksLikeImages(e.dataTransfer)
			) {
				return;
			}
			const text = e.dataTransfer?.getData("text/plain")?.trim();
			if (!text) return;
			// Ignore non-path payloads (e.g. plain prose selection).
			const lines = text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			const pathLike = lines.filter(
				(line) =>
					!line.includes("://") &&
					(line.includes("/") ||
						line.includes("\\") ||
						/\.(md|pdf|tex|bib|json|txt|html?)$/i.test(line)),
			);
			if (!pathLike.length) return;
			e.preventDefault();
			e.stopPropagation();
			attachContextPaths(pathLike);
		},
		[attachContextPaths],
	);

	const attachSkill = (skill: AgentSkill) => {
		setComposerMenuDismissed(true);
		setComposerText((prev) => {
			const token = encodeSkillToken(skill.id);
			if (prev.includes(token)) {
				setSelectedSkillIds(extractSkillIds(prev));
				return prev.replace(
					/(^|\s)[$/][^\s]*$/,
					(_m, prefix: string) => `${prefix}`,
				);
			}
			const next = replaceTrailingTriggerWithToken(prev, "skill", token);
			setSelectedSkillIds(extractSkillIds(next));
			return next;
		});
	};

	const removeSkill = useCallback(
		(skillId: string) => {
			const token = encodeSkillToken(skillId);
			setComposerText((prev) => {
				const next = prev
					.split(token)
					.join("")
					.replace(/[ \t]{2,}/g, " ");
				setSelectedSkillIds(extractSkillIds(next));
				return next;
			});
		},
		[setComposerText, setSelectedSkillIds],
	);

	const attachSlashCommand = useCallback(
		(command: AcpCommand) => {
			setComposerMenuDismissed(true);
			setComposerText((prev) => {
				const token = encodeCommandToken(command.name);
				if (prev.includes(token)) {
					return prev.replace(
						/(^|\s)\/[^\s]*$/,
						(_m, prefix: string) => `${prefix}`,
					);
				}
				return replaceTrailingTriggerWithToken(prev, "command", token);
			});
		},
		[setComposerText],
	);

	const pickQuickOption = (option: QuickOption) => {
		if (option.kind === "skill") {
			attachSkill(option.skill);
			return;
		}
		if (option.kind === "command") {
			attachSlashCommand(option.command);
			return;
		}
		// Drop the half-typed trigger, then open skill management.
		setComposerMenuDismissed(true);
		setComposerText((prev) =>
			prev.replace(/(^|\s)[$/][^\s]*$/, (_m, prefix: string) => prefix),
		);
		openTab(SKILL_MANAGEMENT_PATH);
	};

	const handleComposerMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		// IME: do not treat Enter as mention/skill select while composing.
		// PromptInputTextarea owns compositionend grace + blocks submit; here
		// we only need keyCode 229 / isComposing so menus do not steal the key.
		if (event.key === "Enter" && isImeKeyboardEvent(event)) {
			return;
		}

		if (event.key === "Escape" && activeTabIsRunning) {
			event.preventDefault();
			void cancelCurrentRun();
			return;
		}

		if (event.key === "Escape" && (showMentionMenu || showQuickMenu)) {
			event.preventDefault();
			// While browsing a folder, Esc steps up; only dismiss at root.
			if (showMentionMenu && mentionBrowseRoot) {
				leaveMentionFolder();
				return;
			}
			setComposerMenuDismissed(true);
			setMentionBrowseRoot(null);
			return;
		}

		if (showMentionMenu) {
			if (event.key === "ArrowLeft" && mentionBrowseRoot) {
				event.preventDefault();
				leaveMentionFolder();
				return;
			}
			if (event.key === "ArrowRight") {
				const path =
					mentionOptions[mentionActiveIndex] ?? mentionOptions[0] ?? null;
				if (
					path &&
					mentionPathHasChildren(path, mentionCandidates, paperPathSet)
				) {
					event.preventDefault();
					enterMentionFolder(path);
					return;
				}
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (mentionOptions.length === 0) return;
				setMentionActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % mentionOptions.length
						: (index - 1 + mentionOptions.length) % mentionOptions.length,
				);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const path = mentionOptions[mentionActiveIndex] ?? mentionOptions[0];
				if (path) attachMention(path);
			}
			return;
		}

		if (showQuickMenu) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setQuickActiveIndex((index) =>
					event.key === "ArrowDown"
						? (index + 1) % quickOptions.length
						: (index - 1 + quickOptions.length) % quickOptions.length,
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const option = quickOptions[quickActiveIndex] ?? quickOptions[0];
				if (option) pickQuickOption(option);
			}
			return;
		}

		// ↑ / ↓ → walk previous user prompts (shell-style). Contenteditable has
		// no .value; treat an empty marked draft as empty and ignore caret while
		// already browsing so chips/markers do not block ArrowDown.
		if (switchingRef.current) return;
		const isBrowsing = promptHistoryIndexRef.current !== null;
		const history = collectUserPromptTexts(
			lines,
			stripPromptEnvelopeForDisplay,
		);
		const historyTarget = {
			value: composerText,
			selectionStart: isBrowsing ? 0 : composerText.trim() === "" ? 0 : 1,
			selectionEnd: isBrowsing ? 0 : composerText.trim() === "" ? 0 : 1,
		};

		if (shouldNavigateHistoryUp(event, historyTarget, isBrowsing)) {
			if (history.length === 0) return;
			event.preventDefault();
			if (!isBrowsing) {
				promptHistoryDraftRef.current = composerText;
			}
			const nextIndex = nextHistoryIndexOnUp(
				history.length,
				promptHistoryIndexRef.current,
			);
			if (nextIndex === null) return;
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
			return;
		}

		const downTarget = {
			value: composerText,
			selectionStart: composerText.length,
			selectionEnd: composerText.length,
		};
		if (shouldNavigateHistoryDown(event, downTarget, isBrowsing)) {
			event.preventDefault();
			const nextIndex = nextHistoryIndexOnDown(
				history.length,
				promptHistoryIndexRef.current,
			);
			if (nextIndex === null) {
				const draft = promptHistoryDraftRef.current;
				promptHistoryIndexRef.current = null;
				promptHistoryDraftRef.current = "";
				promptHistoryAppliedRef.current = null;
				setComposerText(draft);
				return;
			}
			const text = history[nextIndex] ?? "";
			promptHistoryIndexRef.current = nextIndex;
			promptHistoryAppliedRef.current = text;
			setComposerText(text);
		}
	};

	/** Clear ↑/↓ history browse when the user edits the recalled text. */
	const onComposerTextChangeFromUser = useCallback(
		(text: string) => {
			if (
				promptHistoryIndexRef.current !== null &&
				text !== promptHistoryAppliedRef.current
			) {
				promptHistoryIndexRef.current = null;
				promptHistoryDraftRef.current = "";
				promptHistoryAppliedRef.current = null;
			}
			setComposerText(text);
			setMentionedPaths(extractMentionPaths(text));
			setSelectedSkillIds(extractSkillIds(text));
		},
		[
			promptHistoryAppliedRef,
			promptHistoryDraftRef,
			promptHistoryIndexRef,
			setComposerText,
			setMentionedPaths,
			setSelectedSkillIds,
		],
	);

	return {
		composerMenuDismissed,
		setComposerMenuDismissed,
		mentionActiveIndex,
		setMentionActiveIndex,
		quickActiveIndex,
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
		mentionCandidates,
		leaveMentionFolder,
		enterMentionFolder,
		attachMention,
		showQuickMenu,
		quickOptions,
		pickQuickOption,
		removeSkill,
		attachContextPaths,
		handleComposerDragOver,
		handleComposerDrop,
		handleComposerMenuKeyDown,
		onComposerTextChangeFromUser,
		composerInputRef,
	};
}
