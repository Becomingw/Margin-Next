/**
 * Markdown → Plate deserialize prep.
 *
 * 1. Preserve extra blank lines that CommonMark would otherwise collapse.
 * 2. Prevent an unclosed block-math fence from consuming the rest of a document.
 * 3. Escape a bare `<` that would crash the MDX JSX tokenizer (e.g. `<0.5B`).
 */

const BLOCK_MATH_FENCE = /^ {0,3}\$\$[ \t]*\r?$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Matches Plate's empty-paragraph serialize placeholder. */
const BLANK_PARAGRAPH_PLACEHOLDER = "\u200B";

/**
 * `remark` / CommonMark collapse 2+ blank lines between blocks into one break.
 * Plate keeps extra empty paragraphs on disk as ZWSP-only lines; rewrite raw
 * extra blanks into that shape before deserialize so external edits and
 * Agent writes round-trip with the same spacing.
 *
 * Skips fenced code and `$$` math blocks. Already-placeholder lines are left
 * alone so Edda-saved files are not double-wrapped.
 */
export function preserveExtraBlankLines(source: string): string {
	const lines = source.split("\n");
	const out: string[] = [];
	let codeFence: { character: string; length: number } | null = null;
	let inMath = false;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const codeMatch = line.match(CODE_FENCE);

		if (!inMath && codeMatch) {
			const marker = codeMatch[1];
			if (!codeFence) {
				codeFence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === codeFence.character &&
				marker.length >= codeFence.length
			) {
				codeFence = null;
			}
			out.push(line);
			i += 1;
			continue;
		}

		if (!codeFence && BLOCK_MATH_FENCE.test(line)) {
			inMath = !inMath;
			out.push(line);
			i += 1;
			continue;
		}

		if (codeFence || inMath || !isCollapsibleBlankLine(line)) {
			out.push(line);
			i += 1;
			continue;
		}

		let j = i;
		while (j < lines.length && isCollapsibleBlankLine(lines[j] ?? "")) {
			j += 1;
		}
		const blankCount = j - i;
		if (blankCount <= 1) {
			for (let k = i; k < j; k += 1) out.push(lines[k] ?? "");
		} else {
			// One blank separates blocks; each extra blank → empty paragraph.
			out.push("");
			for (let extra = 0; extra < blankCount - 1; extra += 1) {
				out.push(BLANK_PARAGRAPH_PLACEHOLDER);
				out.push("");
			}
		}
		i = j;
	}

	return out.join("\n");
}

/** Empty / whitespace-only; ZWSP placeholders count as content. */
function isCollapsibleBlankLine(line: string): boolean {
	return line.replace(/\r$/, "").trim() === "";
}

/**
 * `remark-math` treats a standalone `$$` as a block fence. When its closing
 * fence is missing, the parser legitimately puts all following Markdown into
 * the equation node, which makes unrelated content appear broken in Plate.
 */
function escapeUnclosedBlockMath(source: string): string {
	const fences: number[] = [];
	let codeFence: { character: string; length: number } | null = null;
	let offset = 0;

	for (const line of source.split("\n")) {
		const codeMatch = line.match(CODE_FENCE);
		if (codeMatch) {
			const marker = codeMatch[1];
			if (!codeFence) {
				codeFence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === codeFence.character &&
				marker.length >= codeFence.length
			) {
				codeFence = null;
			}
		} else if (!codeFence && BLOCK_MATH_FENCE.test(line)) {
			fences.push(offset + line.search(/\$\$/));
		}
		offset += line.length + 1;
	}

	if (fences.length % 2 === 0) return source;

	const dollarOffset = fences.at(-1);
	if (dollarOffset === undefined) return source;
	return `${source.slice(0, dollarOffset)}\\${source.slice(dollarOffset)}`;
}

export function prepareMarkdownForDeserialize(source: string): string {
	// Normalize HTML-wrapped Markdown exports (`<h1>`, `<p>`, `<p>|table|</p>`,
	// broken `<em>` inside `$...$`) before running blank-line / math / `<` passes.
	const normalized = normalizeHtmlWrappedMarkdown(source);
	// After the block-math pass so an already-repaired `\$` fence cannot
	// desync the math tracking below.
	return escapeStrayLessThan(
		escapeUnclosedBlockMath(preserveExtraBlankLines(normalized)),
	);
}

const HTML_WRAPPER_DETECT = /<(?:h[1-6]|p|ul|ol|li|script)\b[^>]*>/i;

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function convertInlineHtmlToMarkdown(text: string): string {
	let out = text
		// Repair `*` inside LaTeX superscripts/subscripts that an HTML converter turned into `<em>...</em>`
		.replace(/\{\s*<\/?em>\s*\}/gi, "{*}")
		.replace(/\^\s*<\/?em>/gi, "^*")
		.replace(/_\s*<\/?em>/gi, "_*");
	// Also repair any remaining `<em>` / `</em>` or entities inside inline `$...$` math spans
	out = out.replace(/\$([^$\n]+)\$/g, (_full, inner: string) => {
		const fixed = decodeHtmlEntities(inner.replace(/<\/?em>/gi, "*"));
		return `$${fixed}$`;
	});
	out = out
		.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
		.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
		.replace(/<br\s*\/?>/gi, "\n");
	return decodeHtmlEntities(out);
}

/**
 * Convert HTML-wrapped Markdown files (e.g. `<h1>...</h1>`, `<p>| table |</p>`,
 * `<ul><li>...</li></ul>`, inline `$$...$$`, and trailing `<script>` tags) into
 * standard CommonMark + GFM + LaTeX math so Plate deserializes headings,
 * tables, lists, and equations cleanly.
 *
 * Leaves normal Markdown files (and layout `<div align>` / `<p align>`) untouched.
 */
export function normalizeHtmlWrappedMarkdown(source: string): string {
	if (!HTML_WRAPPER_DETECT.test(source)) return source;
	// Only activate when the document actually uses `<p>...</p>` or `<h1..6>...</h1..6>` block wrappers
	if (!/<(?:h[1-6]|p)>[\s\S]*?<\/(?:h[1-6]|p)>/i.test(source)) {
		return source;
	}

	let out = source
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

	out = out.replace(
		/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
		(_m, level: string, inner: string) => {
			const hashes = "#".repeat(Number(level));
			const cleaned = convertInlineHtmlToMarkdown(inner)
				.replace(/\s*\n\s*/g, " ")
				.trim();
			return `\n\n${hashes} ${cleaned}\n\n`;
		},
	);

	out = out.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");

	out = out.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, body: string) => {
		const items: string[] = [];
		for (const match of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
			items.push(`- ${convertInlineHtmlToMarkdown(match[1] ?? "").trim()}`);
		}
		return items.length ? `\n\n${items.join("\n")}\n\n` : "";
	});

	out = out.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, body: string) => {
		const items: string[] = [];
		let idx = 1;
		for (const match of body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
			items.push(
				`${idx}. ${convertInlineHtmlToMarkdown(match[1] ?? "").trim()}`,
			);
			idx += 1;
		}
		return items.length ? `\n\n${items.join("\n")}\n\n` : "";
	});

	// Unwrap bare `<p>...</p>` (keep `<p align=...>` for remarkPreserveHtml)
	out = out.replace(/<p>([\s\S]*?)<\/p>/gi, (_m, body: string) => {
		let cleaned = convertInlineHtmlToMarkdown(body).trim();
		// Expand single-line display equations `$$...$$` into block math fences
		cleaned = cleaned.replace(
			/(?:^|\n)[ \t]*\$\$([^\n$]+)\$\$[ \t]*(?=\n|$)/g,
			(_eq, formula: string) => `\n\n$$\n${formula.trim()}\n$$\n\n`,
		);
		// Split numbered bibliography lines `[1] ... \n [2] ...` wrapped in a single `<p>` into paragraphs
		cleaned = cleaned.replace(/\r?\n(?=\[\d+\]\s)/g, "\n\n");
		return `\n\n${cleaned}\n\n`;
	});

	// Collapse 3+ consecutive newlines from unwrapping into a single blank line
	out = out.replace(/\r?\n(?:[ \t]*\r?\n){2,}/g, "\n\n").trim();
	return `${out}\n`;
}

/** Characters allowed to start a JSX name (`remarkMdx` tag or fragment). */
const JSX_NAME_START = /[\p{ID_Start}$_]/u;
/** CommonMark whitespace: a `<` before it is plain text, not a tag. */
const MARKDOWN_SPACE = /[ \t\v\f\r]/;
/** Inline regions where `<` is already literal: math spans and code spans. */
const INLINE_LITERAL = /\$\$[^$\n]*\$\$|\$(?:\\\$|[^$\n])+\$|`+[^`\n]*?`+/g;

/**
 * `remarkMdx` hard-crashes on a `<` that is neither text-adjacent whitespace
 * nor a plausible tag start: prose comparisons such as `<0.5B`, `p<0.05`,
 * `<3` or arrows like `<-` throw `Unexpected character … before name`. Plate's
 * recovery then cuts the document at that `<` and silently drops every block
 * after the first line of the remainder (#533). Rewrite such `<` as `&lt;`:
 * neither the MDX tokenizer nor Plate's `htmlToJsx` can mistake an entity for
 * a tag, and remark still decodes it back to a literal `<` in the editor.
 */
export function escapeStrayLessThan(source: string): string {
	if (!source.includes("<")) return source;
	const out: string[] = [];
	let codeFence: { character: string; length: number } | null = null;
	let inMath = false;

	for (const line of source.split("\n")) {
		const codeMatch = line.match(CODE_FENCE);
		if (!inMath && codeMatch) {
			const marker = codeMatch[1];
			if (!codeFence) {
				codeFence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === codeFence.character &&
				marker.length >= codeFence.length
			) {
				codeFence = null;
			}
			out.push(line);
			continue;
		}
		if (!codeFence && BLOCK_MATH_FENCE.test(line)) {
			inMath = !inMath;
			out.push(line);
			continue;
		}
		out.push(
			codeFence || inMath || !line.includes("<") ? line : escapeLine(line),
		);
	}
	return out.join("\n");
}

/** Apply {@link escapeSegment} outside inline code/math spans only. */
function escapeLine(line: string): string {
	let out = "";
	let last = 0;
	for (const match of line.matchAll(INLINE_LITERAL)) {
		const start = match.index ?? 0;
		out += escapeSegment(line.slice(last, start)) + match[0];
		last = start + match[0].length;
	}
	return out + escapeSegment(line.slice(last));
}

function escapeSegment(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "<" && !isEscaped(text, i) && !canStartJsxTag(text, i)) {
			out += "&lt;";
			continue;
		}
		out += text[i];
	}
	return out;
}

/** True when the character at `i` is preceded by an odd number of `\`. */
function isEscaped(text: string, i: number): boolean {
	let backslashes = 0;
	for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) backslashes += 1;
	return backslashes % 2 === 1;
}

/** False when the `<` at `i` would make `remarkMdx` throw immediately. */
function canStartJsxTag(text: string, i: number): boolean {
	if (text.startsWith("<!--", i)) return true;
	const next = text[i + 1];
	if (next === undefined) return false;
	if (next === "/") {
		// Closing tag: only `</name`, `</>` shape; `</3` crashes too.
		const after = text[i + 2];
		return after !== undefined && (after === ">" || JSX_NAME_START.test(after));
	}
	return next === ">" || JSX_NAME_START.test(next) || MARKDOWN_SPACE.test(next);
}
