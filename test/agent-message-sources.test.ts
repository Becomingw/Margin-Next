import { expect, it } from "vitest";
import { splitMessageSources } from "@/lib/agent/message-sources";

it.each([
	"## Sources",
	"**Sources:**",
	"### 参考来源",
	"来源：",
])("collapses the trailing %s appendix without losing citations", (heading) => {
	expect(
		splitMessageSources(
			`Answer\n\n${heading}\n\n- [p.1](papers/a/a.pdf#page=1)`,
		),
	).toEqual({ body: "Answer", sources: "- [p.1](papers/a/a.pdf#page=1)" });
});

it("does not collapse code examples or non-trailing source sections", () => {
	for (const text of [
		"```md\n## Sources\nexample\n```",
		"$$\nSources\n$$",
		"## Sources\n- a\n\n## Analysis\nThe answer",
		"Ordinary answer citing Sources inline.",
	])
		expect(splitMessageSources(text)).toEqual({ body: text, sources: null });
});
