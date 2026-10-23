"use client";

/**
 * Word-style leader line from the active comment's quoted text to its card in
 * the margin, so a comment visibly points at what it is about. Drawn only for
 * the comment under the pointer / selected one; it follows editor scroll and
 * layout changes from the DOM, without re-rendering the editor.
 */

import { type CSSProperties, useEffect, useState } from "react";
import { useStore } from "zustand";
import { cn } from "@/lib/core/utils";
import { reviewStore } from "@/lib/review/store";

type Leader = { d: string; agent: boolean; color: string };

export function ReviewConnector({
	containerRef,
	subscribe,
}: {
	containerRef: React.RefObject<HTMLDivElement | null>;
	/** Fires after the bridge re-measured anchor positions. */
	subscribe: (listener: () => void) => () => void;
}) {
	const activeId = useStore(
		reviewStore,
		(s) => s.activeCommentId ?? s.selectedCommentId,
	);
	const [leader, setLeader] = useState<Leader | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !activeId) {
			setLeader(null);
			return;
		}
		const id = CSS.escape(activeId);
		let frame = 0;
		const update = () => {
			frame = 0;
			const anchors = container.querySelectorAll<HTMLElement>(
				`[data-review-anchor-id="${id}"]`,
			);
			const card = container.querySelector<HTMLElement>(
				`[data-review-comment-id="${id}"]`,
			);
			const last = anchors[anchors.length - 1];
			if (!last || !card) {
				setLeader(null);
				return;
			}
			const box = container.getBoundingClientRect();
			const from = last.getBoundingClientRect();
			const to = card.getBoundingClientRect();
			const x1 = from.right - box.left;
			const y1 = from.bottom - box.top - 1;
			const x2 = to.left - box.left;
			const y2 = to.top - box.top + 14;
			// Along the quoted line to the margin, then across to the card.
			const elbow = Math.max(x1, x2 - 18);
			setLeader({
				d: `M ${x1} ${y1} H ${elbow} L ${x2} ${y2}`,
				agent: card.dataset.reviewActor === "agent",
				// The card carries its Agent's color (`--agent`).
				color: card.style.getPropertyValue("--agent"),
			});
		};
		const schedule = () => {
			if (!frame) frame = window.requestAnimationFrame(update);
		};
		schedule();
		container.addEventListener("scroll", schedule, {
			capture: true,
			passive: true,
		});
		const unsubscribe = subscribe(schedule);
		return () => {
			window.cancelAnimationFrame(frame);
			container.removeEventListener("scroll", schedule, { capture: true });
			unsubscribe();
		};
	}, [activeId, containerRef, subscribe]);

	if (!leader) return null;
	return (
		<svg
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 z-10 size-full overflow-visible",
				leader.agent ? "text-(--agent)" : "text-review-comment",
			)}
			style={
				leader.agent && leader.color
					? ({ "--agent": leader.color } as CSSProperties)
					: undefined
			}
		>
			<path
				d={leader.d}
				fill="none"
				stroke="currentColor"
				strokeOpacity={0.5}
				strokeWidth={1}
			/>
		</svg>
	);
}
