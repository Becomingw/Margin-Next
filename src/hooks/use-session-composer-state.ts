import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type AgentComposerState,
	clearSubmittedComposerState,
	composerScopeKey,
	loadAgentComposerState,
	removeAgentComposerState,
	saveAgentComposerState,
} from "@/lib/agent/composer-state";

type SessionComposerStateOptions = {
	vaultPath: string | null;
	agentId: string | null;
	sessionId: string;
	/** Separate unsent drafts for each paper while the chat store uses "draft". */
	draftKey?: string;
	defaultIncludeSelectedFile: boolean;
};

type ComposerIdentity = {
	scopeKey: string | null;
	sessionId: string;
};

function emptyComposerState(includeSelectedFile: boolean): AgentComposerState {
	return {
		text: "",
		mentionedPaths: [],
		selectedSkillIds: [],
		includeSelectedFile,
	};
}

function browserStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function useSessionComposerState({
	vaultPath,
	agentId,
	sessionId: rawSessionId,
	draftKey = "draft",
	defaultIncludeSelectedFile,
}: SessionComposerStateOptions) {
	const draftKeyRef = useRef(draftKey);
	draftKeyRef.current = draftKey;
	const sessionId = rawSessionId === "draft" ? draftKey : rawSessionId;
	const scopeKey = composerScopeKey(vaultPath, agentId);
	const defaultIncludeSelectedFileRef = useRef(defaultIncludeSelectedFile);
	defaultIncludeSelectedFileRef.current = defaultIncludeSelectedFile;
	const identityRef = useRef<ComposerIdentity>({ scopeKey, sessionId });
	/**
	 * Text applied for the user (a seeded prompt, a quoted selection) moments
	 * before the panel switches to another conversation; that switch would load
	 * the conversation's saved draft over it, so it is carried along instead.
	 */
	const carryRef = useRef<{ text: string; until: number } | null>(null);
	const [state, setState] = useState<AgentComposerState>(() =>
		emptyComposerState(defaultIncludeSelectedFile),
	);
	const stateRef = useRef(state);

	const readState = useCallback((identity: ComposerIdentity) => {
		const storage = browserStorage();
		if (!storage || !identity.scopeKey) {
			return emptyComposerState(defaultIncludeSelectedFileRef.current);
		}
		return (
			loadAgentComposerState(storage, identity.scopeKey, identity.sessionId) ??
			emptyComposerState(defaultIncludeSelectedFileRef.current)
		);
	}, []);

	const commitState = useCallback((next: AgentComposerState) => {
		stateRef.current = next;
		setState(next);
		const storage = browserStorage();
		const identity = identityRef.current;
		if (storage && identity.scopeKey) {
			saveAgentComposerState(
				storage,
				identity.scopeKey,
				identity.sessionId,
				next,
			);
		}
	}, []);

	const updateState = useCallback(
		(updater: SetStateAction<AgentComposerState>) => {
			const current = stateRef.current;
			const next = typeof updater === "function" ? updater(current) : updater;
			if (next === current) return;
			commitState(next);
		},
		[commitState],
	);

	const updateField = useCallback(
		<K extends keyof AgentComposerState>(
			key: K,
			value: SetStateAction<AgentComposerState[K]>,
		) => {
			updateState((current) => {
				const nextValue =
					typeof value === "function"
						? (
								value as (
									previous: AgentComposerState[K],
								) => AgentComposerState[K]
							)(current[key])
						: value;
				return Object.is(nextValue, current[key])
					? current
					: { ...current, [key]: nextValue };
			});
		},
		[updateState],
	);

	const setText: Dispatch<SetStateAction<string>> = useCallback(
		(value) => updateField("text", value),
		[updateField],
	);
	const setMentionedPaths: Dispatch<SetStateAction<string[]>> = useCallback(
		(value) => updateField("mentionedPaths", value),
		[updateField],
	);
	const setSelectedSkillIds: Dispatch<SetStateAction<string[]>> = useCallback(
		(value) => updateField("selectedSkillIds", value),
		[updateField],
	);
	const setIncludeSelectedFile: Dispatch<SetStateAction<boolean>> = useCallback(
		(value) => updateField("includeSelectedFile", value),
		[updateField],
	);

	/** Load another conversation's draft, keeping text held for the switch. */
	const loadIdentity = useCallback(
		(nextIdentity: ComposerIdentity) => {
			identityRef.current = nextIdentity;
			let next = readState(nextIdentity);
			const carry = carryRef.current;
			if (
				carry &&
				Date.now() < carry.until &&
				!next.text.includes(carry.text)
			) {
				next = {
					...next,
					text: next.text.trim() ? `${next.text} ${carry.text}` : carry.text,
				};
				commitState(next);
				return;
			}
			stateRef.current = next;
			setState(next);
		},
		[commitState, readState],
	);

	const holdForNextSession = useCallback((text: string) => {
		carryRef.current = { text, until: Date.now() + 4000 };
	}, []);

	const activateSession = useCallback(
		(nextSessionId: string) => {
			nextSessionId =
				nextSessionId === "draft" ? draftKeyRef.current : nextSessionId;
			loadIdentity({
				scopeKey: identityRef.current.scopeKey,
				sessionId: nextSessionId,
			});
		},
		[loadIdentity],
	);

	const resetSession = useCallback(
		(nextSessionId: string) => {
			nextSessionId =
				nextSessionId === "draft" ? draftKeyRef.current : nextSessionId;
			identityRef.current = {
				scopeKey: identityRef.current.scopeKey,
				sessionId: nextSessionId,
			};
			carryRef.current = null;
			commitState(emptyComposerState(defaultIncludeSelectedFileRef.current));
		},
		[commitState],
	);

	const rebindSession = useCallback(
		(nextSessionId: string, next: AgentComposerState) => {
			const previousIdentity = identityRef.current;
			const storage = browserStorage();
			if (
				storage &&
				previousIdentity.scopeKey &&
				previousIdentity.sessionId !== nextSessionId
			) {
				removeAgentComposerState(
					storage,
					previousIdentity.scopeKey,
					previousIdentity.sessionId,
				);
			}
			identityRef.current = {
				scopeKey: previousIdentity.scopeKey,
				sessionId: nextSessionId,
			};
			commitState(next);
		},
		[commitState],
	);

	const migrateSession = useCallback(
		(nextSessionId: string) => rebindSession(nextSessionId, stateRef.current),
		[rebindSession],
	);

	const completeSubmission = useCallback(
		(nextSessionId: string, submitted: AgentComposerState) => {
			carryRef.current = null;
			const next = clearSubmittedComposerState(stateRef.current, submitted);
			rebindSession(nextSessionId, next);
		},
		[rebindSession],
	);
	const restoreSavedSession = useCallback(
		(previousId: string, nextId: string) => {
			const storage = browserStorage();
			const scope = identityRef.current.scopeKey;
			if (!storage || !scope || previousId === nextId) return;
			const saved = loadAgentComposerState(storage, scope, previousId);
			if (!saved) return;
			identityRef.current = { scopeKey: scope, sessionId: nextId };
			commitState(saved);
		},
		[commitState],
	);

	useLayoutEffect(() => {
		const current = identityRef.current;
		if (current.scopeKey === scopeKey && current.sessionId === sessionId)
			return;
		const nextIdentity = { scopeKey, sessionId };
		if (
			!current.scopeKey &&
			scopeKey &&
			current.sessionId === sessionId &&
			(stateRef.current.text.length > 0 ||
				stateRef.current.mentionedPaths.length > 0 ||
				stateRef.current.selectedSkillIds.length > 0)
		) {
			identityRef.current = nextIdentity;
			commitState(stateRef.current);
			return;
		}
		loadIdentity(nextIdentity);
	}, [commitState, loadIdentity, scopeKey, sessionId]);

	return {
		...state,
		activateSession,
		completeSubmission,
		holdForNextSession,
		restoreSavedSession,
		migrateSession,
		resetSession,
		setIncludeSelectedFile,
		setMentionedPaths,
		setSelectedSkillIds,
		setText,
		snapshot: () => stateRef.current,
	};
}
