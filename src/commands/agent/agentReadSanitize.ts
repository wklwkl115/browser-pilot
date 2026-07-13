/**
 * Agent-facing read sanitizer: strip mechanical identity and local paths from
 * verified read payloads before they enter browser-agent-read/v1.
 */

const FORBIDDEN_KEYS = new Set([
	"tabId",
	"pageEpoch",
	"browserSessionId",
	"backendNodeId",
	"targetGeneration",
	"documentId",
	"path",
	"saved",
	"artifactPath",
	"outputPath",
]);

function looksLikeFilesystemPath(value: string): boolean {
	if (value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value)) return true;
	if (value.includes("/.browser-pilot/") || value.includes("browser-pilot") && value.includes("artifacts")) return true;
	if (/\.(json|txt|log|html)$/i.test(value) && (value.includes("/") || value.includes("\\"))) return true;
	return false;
}

export function sanitizeAgentReadData(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[MaxDepth]";
	if (typeof value === "string") {
		if (looksLikeFilesystemPath(value)) return "[path-redacted]";
		// Drop dense mechanical identity tokens from free text windows.
		return value
			.replace(/"pageEpoch"\s*:\s*"[^"]*"/g, '"pageEpoch":"[redacted]"')
			.replace(/"browserSessionId"\s*:\s*"[^"]*"/g, '"browserSessionId":"[redacted]"')
			.replace(/"tabId"\s*:\s*\d+/g, '"tabId":0')
			.replace(/"backendNodeId"\s*:\s*\d+/g, '"backendNodeId":0')
			.replace(/"targetGeneration"\s*:\s*\d+/g, '"targetGeneration":0');
	}
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitizeAgentReadData(item, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		out[key] = sanitizeAgentReadData(child, depth + 1);
	}
	return out;
}

/** Build a bounded agent-safe window from artifact reader output. */
export function projectAgentReadPayload(raw: unknown, options: { kind: string; description: string; maxChars: number }): Record<string, unknown> {
	const sanitized = sanitizeAgentReadData(raw);
	const text = JSON.stringify(sanitized);
	const truncated = text.length > options.maxChars;
	const window = truncated ? text.slice(0, options.maxChars) : text;
	// Prefer structured sanitized object when small enough.
	if (!truncated && typeof sanitized === "object" && sanitized !== null) {
		return {
			available: true,
			kind: options.kind,
			description: options.description,
			windowed: true,
			value: sanitized,
		};
	}
	return {
		available: true,
		kind: options.kind,
		description: options.description,
		windowed: true,
		truncated,
		text: window,
	};
}
