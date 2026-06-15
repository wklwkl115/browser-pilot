const REDACTED = "[redacted]";

export function redactSensitiveText(text: string): string {
	return String(text)
		.replace(/(\b(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
		.replace(/([?&](?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|secret|password|api[_-]?key|otp|totp)=)[^&#\s"'<>]+/gi, "$1[redacted]");
}

function sensitiveKey(key: string): boolean {
	return /cookie|authorization|token|secret|password|passwd|pwd|apikey|api-key|credential|privatekey|private-key/i.test(key);
}

export function redactSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactSensitiveText(value);
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, seen));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = sensitiveKey(key) ? REDACTED : redactSensitiveValue(item, seen);
	}
	return out;
}
