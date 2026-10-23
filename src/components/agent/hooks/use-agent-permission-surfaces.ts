/**
 * Interactive ACP surfaces: permission requests (ask mode), Codex
 * request_user_input elicitation, Grok ask_user_question, and the
 * tool-shaped ask promoted by the runtime.
 *
 * The permission dialog is modal and blocks global shortcuts. The docked
 * ask-user forms register on the overlay stack as non-modal so Esc can still
 * dismiss them via {@link closeTopOverlay}, but they do not steal shortcut
 * focus from the rest of the app.
 */
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useRef,
	useState,
} from "react";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import {
	type AskUserRequest,
	type ElicitationRequest,
	type PermissionRequest,
	respondAskUser,
	respondElicitation,
	respondPermission,
} from "@/lib/agent";
import type { ToolAskUserRequest } from "@/lib/agent/chat-state";
import { events } from "@/lib/core/bindings";

export type UseAgentPermissionSurfacesOptions = {
	activeSessionId: string;
	toolAskUserRequest: ToolAskUserRequest | null;
	setToolAskUserRequest: Dispatch<SetStateAction<ToolAskUserRequest | null>>;
};

export type AgentPermissionSurfaces = {
	permissionRequest: PermissionRequest | null;
	setPermissionRequest: Dispatch<SetStateAction<PermissionRequest | null>>;
	elicitationRequest: ElicitationRequest | null;
	setElicitationRequest: Dispatch<SetStateAction<ElicitationRequest | null>>;
	askUserRequest: AskUserRequest | null;
	setAskUserRequest: Dispatch<SetStateAction<AskUserRequest | null>>;
};

function useSessionRequest<T extends { sessionId: string }>(
	activeSessionId: string,
): [T | null, Dispatch<SetStateAction<T | null>>] {
	const [requests, setRequests] = useState<Record<string, T>>({});
	const setRequest = useCallback<Dispatch<SetStateAction<T | null>>>(
		(value) => {
			setRequests((previous) => {
				const next =
					typeof value === "function"
						? (value as (previous: T | null) => T | null)(
								previous[activeSessionId] ?? null,
							)
						: value;
				const result = { ...previous };
				if (next) result[next.sessionId] = next;
				else delete result[activeSessionId];
				return result;
			});
		},
		[activeSessionId],
	);
	return [requests[activeSessionId] ?? null, setRequest];
}

export function useAgentPermissionSurfaces({
	activeSessionId,
	toolAskUserRequest,
	setToolAskUserRequest,
}: UseAgentPermissionSurfacesOptions): AgentPermissionSurfaces {
	// Forward ACP permission requests (ask mode) to the user for an explicit decision.
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);
	// Codex Plan-mode request_user_input → form elicitation.
	const [elicitationRequest, setElicitationRequest] =
		useSessionRequest<ElicitationRequest>(activeSessionId);
	// Grok `_x.ai/ask_user_question` extension method.
	const [askUserRequest, setAskUserRequest] =
		useSessionRequest<AskUserRequest>(activeSessionId);

	const permissionRequestRef = useRef(permissionRequest);
	permissionRequestRef.current = permissionRequest;
	useOverlayRegistration(
		"agent-permission",
		permissionRequest !== null,
		() => {
			const req = permissionRequestRef.current;
			if (!req) return;
			void respondPermission(req.requestId, null);
			setPermissionRequest(null);
		},
		{ modal: false },
	);

	const elicitationRequestRef = useRef(elicitationRequest);
	elicitationRequestRef.current = elicitationRequest;
	useOverlayRegistration(
		"agent-elicitation",
		elicitationRequest !== null,
		() => {
			const req = elicitationRequestRef.current;
			if (!req) return;
			void respondElicitation({
				requestId: req.requestId,
				action: "cancel",
			});
			setElicitationRequest(null);
		},
		{ modal: false },
	);

	const askUserRequestRef = useRef(askUserRequest);
	askUserRequestRef.current = askUserRequest;
	useOverlayRegistration(
		"agent-ask-user",
		askUserRequest !== null,
		() => {
			const req = askUserRequestRef.current;
			if (!req) return;
			void respondAskUser({
				requestId: req.requestId,
				action: "cancel",
			});
			setAskUserRequest(null);
		},
		{ modal: false },
	);

	const toolAskUserRequestRef = useRef(toolAskUserRequest);
	toolAskUserRequestRef.current = toolAskUserRequest;
	useOverlayRegistration(
		"agent-tool-ask-user",
		toolAskUserRequest !== null,
		() => {
			setToolAskUserRequest(null);
		},
		{ modal: false },
	);

	useTauriEvent(events.agentPermissionRequest, (payload) =>
		setPermissionRequest(payload),
	);

	useTauriEvent(events.agentElicitationRequest, (payload) => {
		// Prefer host elicitation over tool-card promote.
		if (payload.sessionId === activeSessionId) setToolAskUserRequest(null);
		setElicitationRequest(payload);
	});

	useTauriEvent(events.agentAskUserRequest, (payload) => {
		// Grok ext is the authoritative respond path; drop tool-promote duplicate.
		if (payload.sessionId === activeSessionId) setToolAskUserRequest(null);
		setAskUserRequest(payload);
	});

	return {
		permissionRequest,
		setPermissionRequest,
		elicitationRequest,
		setElicitationRequest,
		askUserRequest,
		setAskUserRequest,
	};
}
