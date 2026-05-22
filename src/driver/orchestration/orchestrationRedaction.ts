import { createHash } from "node:crypto";
import type { JsonRecord, NormalizedBrowserOrchestrationDesired, NormalizedDesiredCookie, NormalizedSessionAssertion } from "./types";

const SENSITIVE_KEY = /cookie|token|authorization|password|secret|body|postdata|websocket|value/i;

export function hashSensitiveString(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string): string {
	return hashSensitiveString(value).slice(0, 16);
}

export function stableJson(value: unknown): string {
	if (value === null || value === undefined) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function redactOrchestrationValue(value: unknown, depth = 0, keyHint = ""): unknown {
	if (depth > 8) return "[MaxDepth]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		if (SENSITIVE_KEY.test(keyHint)) return "[REDACTED]";
		return value.length > 500 ? `${value.slice(0, 500)}…` : value;
	}
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactOrchestrationValue(item, depth + 1, keyHint));
	const out: JsonRecord = {};
	for (const [key, item] of Object.entries(value as JsonRecord)) {
		if (SENSITIVE_KEY.test(key)) {
			out[key] = item === undefined || item === null ? item : "[REDACTED]";
			continue;
		}
		out[key] = redactOrchestrationValue(item, depth + 1, key);
	}
	return out;
}

export function redactCookie(cookie: NormalizedDesiredCookie): JsonRecord {
	const { value: _value, ...safe } = cookie;
	return {
		...safe,
		valuePresent: cookie.value !== undefined,
		valueLength: typeof cookie.value === "string" ? cookie.value.length : undefined,
		valueHash: cookie.valueHash,
	};
}

function redactSessionAssertion(assertion: NormalizedSessionAssertion): JsonRecord {
	switch (assertion.kind) {
		case "url":
			return { ...assertion, includes: assertion.includes ? "[REDACTED]" : undefined, includesLength: assertion.includes?.length };
		case "text":
			return { ...assertion, includes: assertion.includes ? "[REDACTED]" : undefined, includesLength: assertion.includes?.length };
		case "attribute":
			return { ...assertion, equals: assertion.equals ? "[REDACTED]" : undefined, equalsLength: assertion.equals?.length };
		default:
			return { ...assertion };
	}
}

export function redactDesired(desired: NormalizedBrowserOrchestrationDesired): unknown {
	return {
		...desired,
		sessions: desired.sessions.map((session) => ({
			...session,
			preNavigationHooks: session.preNavigationHooks.map((hook) => ({ ...hook, params: redactOrchestrationValue(hook.params) })),
			cookies: session.cookies.map(redactCookie),
			sessionAssertions: session.sessionAssertions ? { ...session.sessionAssertions, checks: session.sessionAssertions.checks.map(redactSessionAssertion) } : undefined,
		})),
	};
}

export function stripCookieValuesFromDesired(desired: NormalizedBrowserOrchestrationDesired): NormalizedBrowserOrchestrationDesired {
	return {
		...desired,
		sessions: desired.sessions.map((session) => ({
			...session,
			preNavigationHooks: session.preNavigationHooks.map((hook) => ({ ...hook, params: redactOrchestrationValue(hook.params) as typeof hook.params })),
			cookies: session.cookies.map((cookie) => {
				const { value: _value, ...safe } = cookie;
				return safe;
			}),
		})),
	};
}

export function redactedCookieParams(cookie: NormalizedDesiredCookie): JsonRecord {
	return {
		url: cookie.url,
		name: cookie.name,
		action: cookie.action,
		domain: cookie.domain,
		path: cookie.path,
		storeId: cookie.storeId,
		secure: cookie.secure,
		httpOnly: cookie.httpOnly,
		sameSite: cookie.sameSite,
		expirationDate: cookie.expirationDate,
		partitionKey: redactOrchestrationValue(cookie.partitionKey),
		valuePresent: cookie.value !== undefined,
		valueLength: typeof cookie.value === "string" ? cookie.value.length : undefined,
		valueHash: cookie.valueHash,
	};
}

export function redactedErrorDetails(value: unknown): JsonRecord {
	const redacted = redactOrchestrationValue(value);
	return redacted && typeof redacted === "object" && !Array.isArray(redacted) ? redacted as JsonRecord : { value: redacted };
}
