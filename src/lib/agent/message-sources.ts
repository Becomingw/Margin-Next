/** Split a trailing source appendix without treating headings inside code as UI. */
export function splitMessageSources(text: string): {
	body: string;
	sources: string | null;
} {
	const lines = text.split("\n");
	let fence: { char: string; length: number } | null = null;
	let start = -1;
	let level = 0;
	let math = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trimEnd();
		const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (delimiter) {
			if (!fence)
				fence = { char: delimiter[1][0], length: delimiter[1].length };
			else if (
				delimiter[1][0] === fence.char &&
				delimiter[1].length >= fence.length &&
				!delimiter[2].trim()
			)
				fence = null;
			continue;
		}
		if (fence) continue;
		if (line.trim() === "$$") {
			math = !math;
			continue;
		}
		if (math) continue;
		const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
		const label = (heading?.[2] ?? line.trim())
			.replace(/^\*\*(.*?)\*\*[:：]?$/, "$1")
			.replace(/[:：]$/, "")
			.trim();
		if (
			/^(sources|references|来源|资料来源|引用来源|参考来源|参考文献)$/i.test(
				label,
			)
		) {
			start = i;
			level = heading?.[1].length ?? 2;
		} else if (heading && start >= 0 && heading[1].length <= level) start = -1;
	}
	return start >= 0
		? {
				body: lines.slice(0, start).join("\n").trimEnd(),
				sources: lines
					.slice(start + 1)
					.join("\n")
					.trim(),
			}
		: { body: text, sources: null };
}
