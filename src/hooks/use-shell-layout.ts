/**
 * Rail layout controller: owns the resizable panel refs and the
 * imperative collapse / expand transitions, and registers them into the
 * ui-store so plain actions (palette, shortcuts, agent) can drive layout.
 */

import { type RefObject, useEffect, useMemo, useRef } from "react";
import { usePanelRef } from "react-resizable-panels";
import {
	type LayoutPresetMode,
	layoutModeRightRatio,
} from "@/lib/shell/layout-presets";
import {
	registerLayoutController,
	setLayoutMode,
	setRightSidebarOpenState,
	setSidebarCollapsedState,
} from "@/lib/shell/ui-store";
import { setNotesSplit, toggleNotesSplit } from "@/lib/workspace/actions";
import { getActiveTabId, getTabs } from "@/lib/workspace/store";
import { tabHasNotesSplit, tabNotesEligible } from "@/lib/workspace/tabs";

export const SIDEBAR_DEFAULT_PX = 200;
export const RIGHT_SIDEBAR_DEFAULT_PX = 320;

export type ShellLayout = {
	sidebarPanelRef: ReturnType<typeof usePanelRef>;
	rightSidebarPanelRef: ReturnType<typeof usePanelRef>;
	sourcePanelRef: ReturnType<typeof usePanelRef>;
	sidebarAsideRef: RefObject<HTMLElement | null>;
	editorPaneRef: RefObject<HTMLDivElement | null>;
	/** Last expanded rail widths in px (survive collapse / PDF immersive round-trips). */
	leftWidthPxRef: RefObject<number>;
	rightWidthPxRef: RefObject<number>;
	resizingRailsRef: RefObject<boolean>;
	finishRailResize: () => void;
};

export function useShellLayout(): ShellLayout {
	const sidebarPanelRef = usePanelRef();
	const rightSidebarPanelRef = usePanelRef();
	const sourcePanelRef = usePanelRef();
	const sidebarAsideRef = useRef<HTMLElement>(null);
	const editorPaneRef = useRef<HTMLDivElement>(null);
	const leftWidthPxRef = useRef(SIDEBAR_DEFAULT_PX);
	const rightWidthPxRef = useRef(RIGHT_SIDEBAR_DEFAULT_PX);
	const resizingRailsRef = useRef(false);
	const resizeFrameRef = useRef(0);

	const controller = useMemo(() => {
		// Commit geometry directly: tweening flex-grow forces Dockview and the
		// entire manuscript to reflow on every frame of a sidebar toggle.
		const finishRailResize = () => {
			cancelAnimationFrame(resizeFrameRef.current);
			resizingRailsRef.current = false;
		};
		const beginRailResize = () => {
			// Changing either rail can also notify its sibling in the same group.
			resizingRailsRef.current = true;
			cancelAnimationFrame(resizeFrameRef.current);
			// ResizeObserver runs after rAF; keep programmatic notifications from
			// overwriting remembered widths/layout presets until it has delivered.
			resizeFrameRef.current = requestAnimationFrame(() => {
				resizeFrameRef.current = requestAnimationFrame(finishRailResize);
			});
		};
		/** Collapse / expand left file-tree panel without remounting. */
		const setLeftCollapsed = (collapsed: boolean) => {
			const panel = sidebarPanelRef.current;
			if (panel) {
				beginRailResize();
				if (collapsed) {
					try {
						panel.collapse();
					} catch {
						// ignore
					}
				} else {
					const targetPx = leftWidthPxRef.current || SIDEBAR_DEFAULT_PX;
					try {
						panel.expand();
						panel.resize(targetPx);
					} catch {
						// ignore
					}
					// expand() fires onResize synchronously and may overwrite the
					// remembered width with the library's default expand size.
					leftWidthPxRef.current = targetPx;
				}
			}
			setSidebarCollapsedState(collapsed);
		};

		/** Collapse / expand right Agent/Backlinks panel (always mounted). */
		const setRightCollapsed = (
			collapsed: boolean,
			_opts?: { focusAgent?: boolean },
		) => {
			const panel = rightSidebarPanelRef.current;
			if (panel) {
				beginRailResize();
				if (collapsed) {
					try {
						panel.collapse();
					} catch {
						// ignore
					}
				} else {
					const targetPx = rightWidthPxRef.current || RIGHT_SIDEBAR_DEFAULT_PX;
					try {
						panel.expand();
						panel.resize(targetPx);
					} catch {
						// ignore
					}
					rightWidthPxRef.current = targetPx;
				}
			}
			setRightSidebarOpenState(!collapsed);
		};

		/** Resize the Agent rail as a fraction of the source + Agent area. */
		const setRightRatio = (ratio: number) => {
			const panel = rightSidebarPanelRef.current;
			const source = sourcePanelRef.current;
			if (!panel || !source) return;
			const total = source.getSize().inPixels + panel.getSize().inPixels;
			if (total <= 0) return;
			const targetPx = Math.round(total * ratio);
			beginRailResize();
			try {
				panel.expand();
				panel.resize(targetPx);
			} catch {
				// ignore
			}
			rightWidthPxRef.current = targetPx;
			setRightSidebarOpenState(true);
		};

		const applyLayoutMode = (mode: LayoutPresetMode) => {
			if (mode === "notes") setNotesSplit(true);
			else setNotesSplit(false);

			if (mode === "reading") {
				setLeftCollapsed(true);
				setRightCollapsed(true);
			} else {
				setRightRatio(layoutModeRightRatio(mode));
			}
			setLayoutMode(mode);
		};

		const focusSidebar = () => {
			setLeftCollapsed(false);
			requestAnimationFrame(() => {
				sidebarAsideRef.current?.querySelector<HTMLElement>("button")?.focus();
			});
		};

		const focusEditorPane = () => {
			editorPaneRef.current
				?.querySelector<HTMLElement>("[contenteditable='true']")
				?.focus();
		};

		const focusNotesEditor = () => {
			const tab = getTabs().find((t) => t.id === getActiveTabId());
			if (tab && tabNotesEligible(tab) && !tabHasNotesSplit(getTabs(), tab)) {
				toggleNotesSplit();
			}
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Prefer a NOTES secondary-pane editor when present.
					const root = editorPaneRef.current;
					if (!root) return;
					const editables = root.querySelectorAll<HTMLElement>(
						"[contenteditable='true']",
					);
					const target = editables[editables.length - 1] ?? editables[0];
					target?.focus();
				});
			});
		};

		return {
			setLeftCollapsed,
			setRightCollapsed,
			applyLayoutMode,
			focusSidebar,
			focusEditorPane,
			focusNotesEditor,
			finishRailResize,
		};
	}, [sidebarPanelRef, rightSidebarPanelRef, sourcePanelRef]);

	useEffect(() => {
		registerLayoutController(controller);
		return () => {
			registerLayoutController(null);
			controller.finishRailResize();
		};
	}, [controller]);

	return {
		sidebarPanelRef,
		rightSidebarPanelRef,
		sourcePanelRef,
		sidebarAsideRef,
		editorPaneRef,
		leftWidthPxRef,
		rightWidthPxRef,
		resizingRailsRef,
		finishRailResize: controller.finishRailResize,
	};
}
