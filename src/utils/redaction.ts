import { stableJson } from "./json";

const REDACTED = "[redacted]";
const REDACTED_BODY = "[redacted body]";
const REDACTED_POST_DATA = "[redacted postData]";

const SENSITIVE_FIELD_NAMES = new Set([
	"authorization",
	"proxyauthorization",
	"cookie",
	"cookies",
	"setcookie",
	"xapikey",
	"xauthtoken",
	"xcsrftoken",
	"xxsrftoken",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"csrftoken",
	"xsrftoken",
	"secret",
	"clientsecret",
	"password",
	"passwd",
	"pwd",
	"apikey",
	"credential",
]);

const BODY_FIELD_NAMES = new Set(["body", "requestbody", "responsebody"]);
const POST_DATA_FIELD_NAMES = new Set(["postdata", "requestpostdata", "payloaddata", "payload"]);

function normalizeFieldName(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sensitiveFieldPlaceholder(key: string): string | undefined {
	const normalized = normalizeFieldName(key);
	if (SENSITIVE_FIELD_NAMES.has(normalized)) return REDACTED;
	if (POST_DATA_FIELD_NAMES.has(normalized)) return REDACTED_POST_DATA;
	if (BODY_FIELD_NAMES.has(normalized)) return REDACTED_BODY;
	return undefined;
}

function shouldRedactPayloadText(key: string, parentPayload: boolean): boolean {
	const normalized = normalizeFieldName(key);
	return parentPayload && (normalized === "text" || normalized === "value" || normalized === "data" || normalized === "content");
}

export function redactSensitiveText(text: string): string {
	return text
		.replace(/((?:^|[\r\n])\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/("(?:cookie|cookies|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|api[_-]?key|postData|payloadData|body)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|api[_-]?key)\s*=\s*)[^;&\s,"'}]+/gi, "$1[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

export function redactSensitiveValue(value: unknown, seen = new WeakSet<object>(), parentPayload = false): unknown {
	if (typeof value === "string") return parentPayload ? REDACTED_BODY : redactSensitiveText(value);
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, seen, parentPayload));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const placeholder = sensitiveFieldPlaceholder(key);
		const normalized = normalizeFieldName(key);
		const payloadField = BODY_FIELD_NAMES.has(normalized) || POST_DATA_FIELD_NAMES.has(normalized);
		if (placeholder && (item === null || item === undefined || typeof item !== "object" || SENSITIVE_FIELD_NAMES.has(normalized) || POST_DATA_FIELD_NAMES.has(normalized))) {
			out[key] = placeholder;
			continue;
		}
		if (shouldRedactPayloadText(key, parentPayload)) {
			out[key] = REDACTED_BODY;
			continue;
		}
		out[key] = redactSensitiveValue(item, seen, payloadField);
	}
	return out;
}

export function containsSensitiveEvidence(value: unknown): boolean {
	const raw = typeof value === "string" ? value : stableJson(value);
	const redacted = typeof value === "string" ? redactSensitiveText(value) : stableJson(redactSensitiveValue(value));
	return raw !== redacted;
}
