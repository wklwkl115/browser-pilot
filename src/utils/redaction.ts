import { stableJson } from "./json.js";

const REDACTED = "[redacted]";
const REDACTED_BODY = "[redacted body]";
const REDACTED_POST_DATA = "[redacted postData]";
const QUERY_PARAM_RE = /([?&])([^=&#\s"'<>]{1,120})=([^&#\s"'<>]*)/g;
const EMAIL_VALUE_RE = /^[^\s@/?#&=]+@[^\s@/?#&=]+\.[^\s@/?#&=]+$/i;

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
	"privatekey",
	"privatepem",
	"secretkey",
	"sessiontoken",
	"securitytoken",
	"mfatoken",
	"otptoken",
	"totp",
	"otp",
	"xawssecuritytoken",
	"xawsec2metadatatoken",
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

function decodeQueryComponent(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, " "));
	} catch {
		return value.replace(/\+/g, " ");
	}
}

function queryValueLooksFreeText(rawValue: string): boolean {
	const value = decodeQueryComponent(rawValue).trim();
	if (!value) return false;
	const words = value.split(/\s+/).filter(Boolean);
	if (words.length < 2) return false;
	return /[\p{L}\p{Script=Han}]/u.test(value);
}

function queryValueLooksPii(rawValue: string): boolean {
	const value = decodeQueryComponent(rawValue).trim();
	if (!value) return false;
	if (EMAIL_VALUE_RE.test(value)) return true;
	const digits = value.replace(/\D/g, "");
	if (/^\+/.test(value) && digits.length >= 10) return true;
	if (/[\s().-]/.test(value) && digits.length >= 10 && /^[+\d\s().-]+$/.test(value)) return true;
	return /^1\d{10}$/.test(value);
}

function redactUrlQueryValues(text: string): string {
	return text.replace(QUERY_PARAM_RE, (match, prefix: string, rawKey: string, rawValue: string) => {
		if (queryValueLooksFreeText(rawValue) || queryValueLooksPii(rawValue)) return `${prefix}${rawKey}=${REDACTED}`;
		return match;
	});
}

export function redactSensitiveText(text: string): string {
	return redactUrlQueryValues(String(text))
		.replace(/((?:^|[\r\n])\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/("(?:cookie|cookies|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|secret|private[_-]?key|password|api[_-]?key|otp|totp|postData|payloadData|body)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|secret|private[_-]?key|password|api[_-]?key|otp|totp)\s*=\s*)[^;&\s,"'}]+/gi, "$1[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
		.replace(/([?&](?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|secret|password|api[_-]?key|otp|totp)=)[^&#\s"'<>]+/gi, "$1[redacted]")
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]");
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
