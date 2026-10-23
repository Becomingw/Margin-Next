"use client";

/**
 * Citation picker for review manuscripts.
 *
 * Inserts references that survive leaving the vault: a Pandoc-style
 * `[@citekey]` cross-reference (when the library has a BibTeX key) or a
 * readable author-year citation otherwise. Deliberately not a deep link into
 * this vault's notes — the manuscript travels, the vault does not.
 */

import { BookMarked, Quote } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import { useLibraryStore } from "@/hooks/use-app-stores";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";

export type CitationChoice = {
	/** Text inserted into the manuscript. */
	token: string;
	/** True when it is a cross-reference the recipient can resolve. */
	crossRef: boolean;
};

function authorsLabel(authors: string[] | undefined): string {
	if (!authors?.length) return "";
	const first = authors[0].split(/\s+/).filter(Boolean).at(-1) ?? authors[0];
	return authors.length === 1 ? first : `${first} et al.`;
}

/** `[@key]` when a key exists, else `(First et al., Year)`. */
export function citationFor(paper: PaperMetadata): CitationChoice {
	const key = paper.bibtex_key?.trim();
	if (key) return { crossRef: true, token: `[@${key}]` };
	const who = authorsLabel(paper.authors);
	const year = paper.year ? String(paper.year) : "";
	const parts = [who, year].filter(Boolean).join(", ");
	return { crossRef: false, token: `(${parts})` };
}

type CitationPickerProps = {
	point: { x: number; y: number };
	onPick: (choice: CitationChoice) => void;
	onClose: () => void;
};

export function CitationPicker({
	point,
	onPick,
	onClose,
}: CitationPickerProps) {
	const { t } = useTranslation("review");
	const papers = useLibraryStore((s) => s.papers);
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => inputRef.current?.focus(), []);

	const results = useMemo(() => {
		const q = query.trim().toLowerCase();
		const rows = q
			? papers.filter((p) =>
					`${p.title} ${p.authors.join(" ")} ${p.publication ?? ""}`
						.toLowerCase()
						.includes(q),
				)
			: papers;
		return [...rows].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, 8);
	}, [papers, query]);

	return (
		<ViewportFloating
			className="z-50 w-72 rounded-lg border bg-popover p-1 shadow-floating ring-1 ring-border"
			onMouseDown={(e) => e.stopPropagation()}
			point={point}
			side="top"
		>
			<input
				className="h-7 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
				onBlur={() => window.setTimeout(onClose, 120)}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						onClose();
					}
				}}
				placeholder={t("citation.search")}
				ref={inputRef}
				value={query}
			/>
			<div className="edda-scroll mt-1 max-h-64 overflow-y-auto">
				{results.length === 0 ? (
					<p className="px-2 py-3 text-muted-foreground text-xs">
						{t("citation.empty")}
					</p>
				) : (
					results.map((paper) => {
						const choice = citationFor(paper);
						return (
							<button
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
								key={paper.path || paper.id}
								onClick={() => onPick(choice)}
								type="button"
							>
								{choice.crossRef ? (
									<BookMarked
										className="size-3.5 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								) : (
									<Quote
										className="size-3.5 shrink-0 text-muted-foreground"
										aria-hidden
									/>
								)}
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm">
										{paper.title || paper.path}
									</span>
									<span className="block truncate text-[11px] text-muted-foreground">
										{[
											authorsLabel(paper.authors),
											paper.year,
											paper.publication,
										]
											.filter(Boolean)
											.join(" · ")}
									</span>
								</span>
								<span
									className={cn(
										"shrink-0 font-mono text-[11px] text-muted-foreground",
										choice.crossRef && "text-foreground",
									)}
								>
									{choice.token}
								</span>
							</button>
						);
					})
				)}
			</div>
		</ViewportFloating>
	);
}
