/** Best-effort redaction for diagnostic error strings, never for storing secrets. */
export function redactLogText(text: string): string {
	return text
		.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
			"$1[redacted]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(
			/([?&](?:key|token|signature|api_key)=)[^&#\s]+/gi,
			"$1[redacted]",
		);
}
