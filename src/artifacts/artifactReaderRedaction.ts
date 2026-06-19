import { browserArtifactPrivacyMetadata, redactSensitiveText, redactSensitiveValue } from "./artifactPrivacy.js";
import type { BrowserArtifactReadResult, TextSnippet } from "./artifactReaderShared.js";

function privacySummary(redacted: boolean, targetedRaw = false) {
	return redacted ? { redaction: "default", ...browserArtifactPrivacyMetadata() } : { redaction: targetedRaw ? "targeted_raw" : "disabled", localOnly: true };
}

function redactSnippetText(text: string): string {
	return redactSensitiveText(text).replace(/(^|[\r\n])(\s*\d+:\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token)\s*:\s*)[^\r\n]*/gi, "$1$2[redacted]");
}

function redactTextSnippet<T extends TextSnippet>(snippet: T): T {
	return { ...snippet, text: redactSnippetText(snippet.text) };
}

function searchQueryLooksSecretProbe(query: string): boolean {
	const trimmed = query.trim();
	if (!trimmed) return false;
	if (/\b(?:Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]+)\b/i.test(trimmed)) return true;
	if (/\b(?:cookie|authorization|proxy-authorization|auth|token|secret|password|passwd|pwd|csrf|xsrf|api[_-]?key|session(?:id)?)\b\s*[:=]\s*\S+/i.test(trimmed)) return true;
	if (/\b(?:cookie|auth|token|secret|password|passwd|pwd|csrf|xsrf|api[_-]?key|session(?:id)?)[_-]+[a-z0-9_-]*(?:secret|token|key|pwd|session|cookie|live|value)\b/i.test(trimmed)) return true;
	return !/\s/.test(trimmed) && trimmed.length >= 20 && /\d/.test(trimmed) && /[a-z]/i.test(trimmed) && /[A-Z_-]/.test(trimmed);
}

function redactSearchQuery(query: string): string {
	const redacted = redactSensitiveText(query);
	if (redacted !== query) return redacted;
	return searchQueryLooksSecretProbe(query) ? "[redacted]" : query;
}

export function redactArtifactResult<T extends BrowserArtifactReadResult>(result: T, redacted: boolean, targetedRaw = false): T {
	const summary = { ...result.summary, privacy: privacySummary(redacted, targetedRaw) };
	if (!redacted) return { ...result, summary } as T;
	if (result.mode === "text") return { ...result, summary, snippets: result.snippets.map(redactTextSnippet) } as T;
	if (result.mode === "search") return { ...result, summary, query: redactSearchQuery(result.query), snippets: result.snippets.map(redactTextSnippet) } as T;
	if (result.mode === "sample") return { ...result, summary, snippets: result.snippets.map(redactTextSnippet) } as T;
	return { ...result, summary, value: redactSensitiveValue(result.value) } as T;
}
