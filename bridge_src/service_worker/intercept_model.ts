import { redactSensitive } from "./runtime";
import type { JsonRecord, PiBridgeCommand } from "./types";

export type InterceptPhase = "request" | "response";
export type InterceptAction = "continue" | "fail" | "fulfill" | "replaceScript";

export type InterceptRuleMatcher = JsonRecord & {
	urlContains?: string;
	method?: string;
	resourceType?: string;
	stage?: InterceptPhase;
};

export type InterceptRule = JsonRecord & {
	ruleId: string;
	createdAt: number;
	matcher: InterceptRuleMatcher;
	action: InterceptAction;
	patch?: JsonRecord;
};

export type InterceptTranscriptEntry = JsonRecord & {
	seq: number;
	t: number;
	event: string;
	requestId?: string;
	ruleId?: string;
	stage?: InterceptPhase;
	url?: string;
	method?: string;
	resourceType?: string;
	status?: number;
	action?: string;
	diagnostics?: JsonRecord;
};

export type InterceptSession = JsonRecord & {
	tabId: number;
	sessionId: string;
	key: string;
	active: boolean;
	createdAt: number;
	installedAt?: number;
	lastEventAt?: number;
	stages: InterceptPhase[];
	rules: InterceptRule[];
	transcript: InterceptTranscriptEntry[];
	paused: Map<string, JsonRecord>;
	diagnostics: JsonRecord[];
	seq: number;
	maxTranscript: number;
	cdpSubscriptions: string[];
};

export const piBrowserInterceptSessions = new Map<string, InterceptSession>();

const PI_BROWSER_INTERCEPT_DEFAULT_MAX_TRANSCRIPT = 200;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	return text ? text : undefined;
}

function asStage(value: unknown): InterceptPhase {
	return String(value || "request").trim().toLowerCase() === "response" ? "response" : "request";
}

function asAction(value: unknown): InterceptAction {
	const normalized = String(value || "continue").trim();
	if (normalized === "fail" || normalized === "fulfill" || normalized === "replaceScript") return normalized;
	return "continue";
}

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function stringifyInterceptBody(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return String(value);
}

function encodeBase64Utf8(text: string): string {
	return btoa(unescape(encodeURIComponent(text)));
}

export function normalizeInterceptHeaders(value: unknown, fallbackContentType?: string): Array<{ name: string; value: string }> {
	const headers = Array.isArray(value)
		? value.map((item) => ({ name: String(asRecord(item).name || ""), value: String(asRecord(item).value || "") })).filter((item) => item.name)
		: Object.entries(asRecord(value)).map(([name, entryValue]) => ({ name, value: String(entryValue) }));
	if (!headers.length && fallbackContentType) headers.push({ name: "content-type", value: fallbackContentType });
	return headers;
}

export function normalizeInterceptRequestPatch(value: unknown): { cdpPatch: JsonRecord; summary: JsonRecord } {
	const patch = asRecord(value);
	const cdpPatch: JsonRecord = {};
	const mutatedFields: string[] = [];
	const summary: JsonRecord = { mutatedFields };
	const url = asString(patch.url);
	if (url) {
		cdpPatch.url = url;
		mutatedFields.push("url");
		summary.url = url;
	}
	const method = asString(patch.method)?.toUpperCase();
	if (method) {
		cdpPatch.method = method;
		mutatedFields.push("method");
		summary.method = method;
	}
	const headers = normalizeInterceptHeaders(patch.headers ?? patch.requestHeaders ?? patch.request_headers);
	if (headers.length) {
		cdpPatch.headers = headers;
		mutatedFields.push("headers");
		summary.headerCount = headers.length;
	}
	const interceptResponse = patch.interceptResponse ?? patch.intercept_response;
	if (typeof interceptResponse === "boolean") {
		cdpPatch.interceptResponse = interceptResponse;
		mutatedFields.push("interceptResponse");
		summary.interceptResponse = interceptResponse;
	}
	const bodyBase64 = asString(patch.bodyBase64 ?? patch.body_base64 ?? patch.postDataBase64 ?? patch.post_data_base64);
	if (bodyBase64) {
		cdpPatch.postData = bodyBase64;
		mutatedFields.push("postData");
		summary.usedBodyBase64 = true;
	} else if (patch.body !== undefined || patch.postData !== undefined) {
		const sourceField = patch.body !== undefined ? "body" : "postData";
		const bodyText = stringifyInterceptBody(patch.body !== undefined ? patch.body : patch.postData);
		cdpPatch.postData = encodeBase64Utf8(bodyText);
		mutatedFields.push("postData");
		summary.bodyBytes = bodyText.length;
		summary.bodySourceField = sourceField;
	}
	return { cdpPatch, summary };
}

export function interceptSessionKey(tabId: unknown, sessionId: unknown): string {
	return `${Number(tabId)}:${String(sessionId || "default")}`;
}

export function defaultInterceptSessionId(msg: PiBridgeCommand | JsonRecord | null | undefined): string {
	return String(msg?.sessionId || msg?.session_id || "default");
}

function normalizeInterceptStages(value: unknown): InterceptPhase[] {
	const raw = Array.isArray(value) ? value : value === undefined || value === null ? ["request", "response"] : [value];
	const out: InterceptPhase[] = [];
	for (const item of raw) {
		const stage = asStage(item);
		if (!out.includes(stage)) out.push(stage);
	}
	return out.length ? out : ["request", "response"];
}

export function normalizeInterceptInstallConfig(msg: PiBridgeCommand | JsonRecord = {}): { sessionId: string; maxTranscript: number; stages: InterceptPhase[] } {
	return {
		sessionId: defaultInterceptSessionId(msg),
		maxTranscript: numberInRange(msg.maxTranscript ?? msg.max_transcript, PI_BROWSER_INTERCEPT_DEFAULT_MAX_TRANSCRIPT, 1, 5000),
		stages: normalizeInterceptStages(msg.stages ?? msg.requestStages ?? msg.request_stages),
	};
}

export function createInterceptSession(tabId: unknown, config: { sessionId: string; maxTranscript: number; stages: InterceptPhase[] }): InterceptSession {
	return {
		tabId: Number(tabId),
		sessionId: config.sessionId,
		key: interceptSessionKey(tabId, config.sessionId),
		active: false,
		createdAt: Date.now(),
		stages: config.stages,
		rules: [],
		transcript: [],
		paused: new Map(),
		diagnostics: [],
		seq: 0,
		maxTranscript: config.maxTranscript,
		cdpSubscriptions: [],
	};
}

export function getInterceptSession(tabId: unknown, sessionId: unknown): InterceptSession | null {
	return piBrowserInterceptSessions.get(interceptSessionKey(tabId, sessionId)) || null;
}

export function getActiveInterceptSession(tabId: unknown, msg: PiBridgeCommand | JsonRecord | null | undefined): InterceptSession | null {
	return getInterceptSession(tabId, defaultInterceptSessionId(msg));
}

export function normalizeInterceptRule(msg: PiBridgeCommand | JsonRecord = {}): InterceptRule {
	const matcher = asRecord(msg.matcher);
	return {
		ruleId: asString(msg.ruleId ?? msg.rule_id) || `intrule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		createdAt: Date.now(),
		matcher: {
			urlContains: asString(matcher.urlContains ?? matcher.url_contains ?? msg.urlContains ?? msg.url_contains),
			method: asString(matcher.method ?? msg.method)?.toUpperCase(),
			resourceType: asString(matcher.resourceType ?? matcher.resource_type ?? msg.resourceType ?? msg.resource_type),
			stage: asStage(matcher.stage ?? msg.stage),
		},
		action: asAction(msg.action),
		patch: asRecord(msg.patch),
	};
}

export function rememberInterceptTranscript(session: InterceptSession | null | undefined, entry: JsonRecord): void {
	if (!session) return;
	session.seq += 1;
	const item: InterceptTranscriptEntry = redactSensitive({ seq: session.seq, t: Date.now(), ...entry }) as InterceptTranscriptEntry;
	session.transcript.push(item);
	if (session.transcript.length > session.maxTranscript) session.transcript.splice(0, session.transcript.length - session.maxTranscript);
	session.lastEventAt = Date.now();
}

export function rememberInterceptDiagnostic(session: InterceptSession | null | undefined, entry: JsonRecord): void {
	if (!session) return;
	session.diagnostics.push(redactSensitive({ t: Date.now(), ...entry }) as JsonRecord);
	if (session.diagnostics.length > 100) session.diagnostics.splice(0, session.diagnostics.length - 100);
}

export function interceptSessionSummary(session: InterceptSession | null | undefined): JsonRecord | null {
	if (!session) return null;
	return {
		tabId: session.tabId,
		sessionId: session.sessionId,
		active: session.active,
		createdAt: session.createdAt,
		installedAt: session.installedAt,
		lastEventAt: session.lastEventAt,
		ruleCount: session.rules.length,
		pausedCount: session.paused.size,
		transcriptCount: session.transcript.length,
		maxTranscript: session.maxTranscript,
		stages: session.stages,
		subscriptionCount: session.cdpSubscriptions.length,
		rules: session.rules.map((rule) => ({
			ruleId: rule.ruleId,
			action: rule.action,
			stage: rule.matcher.stage,
			urlContains: rule.matcher.urlContains,
			method: rule.matcher.method,
			resourceType: rule.matcher.resourceType,
			createdAt: rule.createdAt,
		})),
		diagnostics: session.diagnostics.slice(-20),
	};
}

export function interceptRuleMatches(rule: InterceptRule, candidate: { stage: InterceptPhase; url?: unknown; method?: unknown; resourceType?: unknown }): boolean {
	const matcher = rule.matcher || {};
	if (matcher.stage && matcher.stage !== candidate.stage) return false;
	if (matcher.urlContains && !String(candidate.url || "").includes(matcher.urlContains)) return false;
	if (matcher.method && String(candidate.method || "").toUpperCase() !== matcher.method) return false;
	if (matcher.resourceType && String(candidate.resourceType || "") !== matcher.resourceType) return false;
	return true;
}

export function classifyInterceptStage(value: unknown): InterceptPhase {
	return asStage(value);
}
