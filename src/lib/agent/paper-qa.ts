import type { SelectionContext } from "@/lib/agent/selection-reference";

/** Bump with the bundled paper-qa SKILL.md so resumed conversations refresh old instructions. */
export const PAPER_QA_INSTRUCTIONS_VERSION = 3;

export function needsPaperQaInstructions(
	resumable: boolean,
	deliveredVersion?: number,
): boolean {
	return !resumable || deliveredVersion !== PAPER_QA_INSTRUCTIONS_VERSION;
}

function pdfReferencePaths(references: SelectionContext[]): string[] {
	return references
		.filter(
			(ref) =>
				ref.origin === "pdf" &&
				ref.sourcePath !== "PDF" &&
				!/^(?:https?:|edda:)/i.test(ref.sourcePath),
		)
		.map((ref) => ref.sourcePath);
}

/** Explicit references outrank the workspace tab (which can change while typing). */
export function referenceContextPaths(
	references: SelectionContext[],
	paths: string[],
	explicitPaths: string[],
	sessionPapers: string[] = [],
): string[] {
	const papers = pdfReferencePaths(references);
	const bound = papers.length ? papers : sessionPapers;
	return [...new Set(bound.length ? [...bound, ...explicitPaths] : paths)];
}

export function paperQaPaths(
	references: SelectionContext[],
	previous: string[] = [],
): string[] {
	return [...new Set([...pdfReferencePaths(references), ...previous])];
}

/** User-selected skills take precedence; default QA is a small read-only workflow. */
export function paperQaSkills(ids: string[], qa: boolean): string[] {
	return ids.length || !qa ? ids : ["paper-qa"];
}
