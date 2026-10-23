import { describe, expect, it } from "vitest";
import { redactLogText } from "@/lib/core/log-redaction";

describe("diagnostic redaction", () => {
	it("removes credentials while preserving useful failure context", () => {
		const text =
			'session=s1 HTTP 401 Authorization: Bearer token-value apiKey="secret-value" password=abc https://user:pass@example.org/a?token=hidden&x=1';
		const safe = redactLogText(text);
		for (const secret of [
			"token-value",
			"secret-value",
			"abc",
			"user:pass",
			"hidden",
		])
			expect(safe).not.toContain(secret);
		expect(safe).toContain("session=s1 HTTP 401");
		expect(safe).toContain("example.org/a?token=[redacted]&x=1");
	});
});
