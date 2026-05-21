import { randomUUID } from "node:crypto";
import { invalidDesired } from "./orchestrationErrors";
import { hashSensitiveString, shortHash, stableJson } from "./orchestrationRedaction";
import type {
	BrowserDesiredCookieInput,
	BrowserDesiredSessionInput,
	BrowserDesiredTabInput,
	BrowserOrchestrationDesiredInput,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	NormalizedDesiredCookie,
	NormalizedDesiredSession,
	NormalizedDesiredTab,
	NormalizedHookDispatcher,
	NormalizedNetworkRecorder,
	NormalizedOwnedWindow,
	NormalizedVisualGrouping,
} from "./types";

const TAG_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, field: string, options: { required?: boolean; pattern?: RegExp } = {}): string | undefined {
	if (value === undefined || value === null || value === "") {
		if (options.required) throw invalidDesired(`${field} is required`, { field });
		return undefined;
	}
	if (typeof value !== "string") throw invalidDesired(`${field} must be a string`, { field });
	const out = value.trim();
	if (!out && options.required) throw invalidDesired(`${field} is required`, { field });
	if (options.pattern && !options.pattern.test(out)) throw invalidDesired(`${field} contains unsupported characters`, { field, value: out });
	return out || undefined;
}

function booleanField(value: unknown, fallback: boolean, field: string): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw invalidDesired(`${field} must be boolean`, { field });
	return value;
}

function numberField(value: unknown, fallback: number | undefined, field: string, min: number, max: number): number | undefined {
	if (value === undefined || value === null || value === "") return fallback;
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	if (!Number.isFinite(n) || n < min || n > max) throw invalidDesired(`${field} must be a number between ${min} and ${max}`, { field, value });
	return n;
}

function normalizeHttpUrl(value: unknown, field: string): { url: string; origin: string } {
	const raw = stringField(value, field, { required: true });
	try {
		const parsed = new URL(raw || "");
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
		return { url: parsed.href, origin: parsed.origin };
	} catch {
		throw invalidDesired(`${field} must be an absolute http(s) URL`, { field, value: raw });
	}
}

function originFromInput(value: unknown, field: string): string {
	const raw = stringField(value, field, { required: true }) || "";
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
		return parsed.origin;
	} catch {
		throw invalidDesired(`${field} must be an absolute http(s) origin or URL`, { field, value: raw });
	}
}

function assertAllowedOrigin(origin: string, allowedOrigins: Set<string>, field: string): void {
	if (!allowedOrigins.size || allowedOrigins.has(origin)) return;
	throw invalidDesired(`${field} origin is outside allowedOrigins`, { field, origin, allowedOrigins: Array.from(allowedOrigins).sort() });
}

function normalizeWaitUntil(value: unknown): NormalizedDesiredTab["waitUntil"] {
	if (value === undefined || value === null || value === "") return "complete";
	const raw = String(value).trim().toLowerCase().replace(/[._-]/g, "");
	if (raw === "none") return "none";
	if (raw === "domcontentloaded" || raw === "interactive") return "domcontentloaded";
	if (raw === "complete" || raw === "load") return "complete";
	if (raw === "networkidle" || raw === "networkidle0") return "networkIdle";
	throw invalidDesired("tab waitUntil must be one of none, domcontentloaded, complete, networkIdle", { field: "waitUntil", value });
}

function normalizeReuse(value: unknown): NormalizedDesiredTab["reuse"] {
	if (value === undefined || value === null || value === "") return "owned";
	const raw = String(value).trim();
	if (raw === "none" || raw === "matchingUrl" || raw === "owned") return raw;
	throw invalidDesired("tab reuse must be one of none, matchingUrl, owned", { field: "reuse", value });
}

function normalizeTabs(sessionTag: string, session: BrowserDesiredSessionInput, defaults: { tabRole: string }, allowedOrigins: Set<string>): NormalizedDesiredTab[] {
	const rawTabs = Array.isArray(session.tabs) ? session.tabs as BrowserDesiredTabInput[] : [];
	const inputs: BrowserDesiredTabInput[] = [...rawTabs];
	if (session.url !== undefined) inputs.unshift({ role: defaults.tabRole, url: session.url });
	if (!inputs.length) return [];
	const seen = new Set<string>();
	return inputs.map((item, index) => {
		if (!isRecord(item)) throw invalidDesired("session tabs must be objects", { sessionTag, index });
		const role = stringField(item.role ?? (index === 0 ? defaults.tabRole : undefined), "tab.role", { required: true, pattern: TAG_PATTERN }) || defaults.tabRole;
		if (seen.has(role)) throw invalidDesired("session tab roles must be unique", { sessionTag, role });
		seen.add(role);
		const parsedUrl = normalizeHttpUrl(item.url, "tab.url");
		assertAllowedOrigin(parsedUrl.origin, allowedOrigins, "tab.url");
		return {
			sessionTag,
			role,
			url: parsedUrl.url,
			origin: parsedUrl.origin,
			reuse: normalizeReuse(item.reuse),
			active: booleanField(item.active, index === 0, "tab.active"),
			waitUntil: normalizeWaitUntil(item.waitUntil),
			recreateOnMissing: booleanField(item.recreateOnMissing, true, "tab.recreateOnMissing"),
			required: booleanField(item.required, true, "tab.required"),
		};
	});
}

function normalizeSameSite(value: unknown): NormalizedDesiredCookie["sameSite"] | undefined {
	if (value === undefined) return undefined;
	const raw = String(value).trim().toLowerCase();
	if (raw === "no_restriction" || raw === "lax" || raw === "strict" || raw === "unspecified") return raw;
	throw invalidDesired("cookie sameSite must be one of no_restriction, lax, strict, unspecified", { field: "sameSite", value });
}

function normalizeCookie(sessionTag: string, raw: BrowserDesiredCookieInput, tabs: NormalizedDesiredTab[], allowedOrigins: Set<string>, index: number): NormalizedDesiredCookie {
	if (!isRecord(raw)) throw invalidDesired("session cookies must be objects", { sessionTag, index });
	const tabRole = stringField(raw.tabRole, "cookie.tabRole", { pattern: TAG_PATTERN }) || tabs[0]?.role || "main";
	const tab = tabs.find((item) => item.role === tabRole) || tabs[0];
	const parsedUrl = normalizeHttpUrl(raw.url ?? tab?.url, "cookie.url");
	assertAllowedOrigin(parsedUrl.origin, allowedOrigins, "cookie.url");
	const name = stringField(raw.name, "cookie.name", { required: true }) || "";
	const remove = booleanField(raw.remove, false, "cookie.remove");
	const hasValue = raw.value !== undefined && raw.value !== null;
	if (!remove && !hasValue) throw invalidDesired("cookie requires value or remove:true", { sessionTag, name });
	if (remove && hasValue) throw invalidDesired("cookie cannot set value and remove:true in the same desired item", { sessionTag, name });
	if (hasValue && typeof raw.value !== "string") throw invalidDesired("cookie value must be a string", { sessionTag, name, field: "value" });
	const value = hasValue ? String(raw.value) : undefined;
	const path = stringField(raw.path, "cookie.path");
	const domain = stringField(raw.domain, "cookie.domain");
	const storeId = stringField(raw.storeId, "cookie.storeId");
	const secure = raw.secure === undefined ? undefined : booleanField(raw.secure, false, "cookie.secure");
	const httpOnly = raw.httpOnly === undefined ? undefined : booleanField(raw.httpOnly, false, "cookie.httpOnly");
	const expirationDate = numberField(raw.expirationDate, undefined, "cookie.expirationDate", 0, Number.MAX_SAFE_INTEGER);
	if (raw.partitionKey !== undefined && !isRecord(raw.partitionKey)) throw invalidDesired("cookie partitionKey must be an object", { sessionTag, name, field: "partitionKey" });
	return {
		key: `${sessionTag}:${tabRole}:${name}:${parsedUrl.origin}:${path || ""}:${domain || ""}:${index}`,
		sessionTag,
		tabRole,
		url: parsedUrl.url,
		origin: parsedUrl.origin,
		name,
		action: remove ? "remove" : "set",
		value,
		valueHash: value === undefined ? undefined : hashSensitiveString(value),
		domain,
		path,
		storeId,
		partitionKey: raw.partitionKey as JsonRecord | undefined,
		secure,
		httpOnly,
		sameSite: normalizeSameSite(raw.sameSite),
		expirationDate,
		required: booleanField(raw.required, true, "cookie.required"),
	};
}

function passThroughConfig(raw: JsonRecord, allowed: string[]): JsonRecord {
	const out: JsonRecord = {};
	for (const key of allowed) if (raw[key] !== undefined) out[key] = raw[key];
	return out;
}

function assertNoPreNavigationExecutableFields(value: unknown, field: string, depth = 0): void {
	if (depth > 16 || value === null || value === undefined || typeof value !== "object") return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertNoPreNavigationExecutableFields(item, `${field}[${index}]`, depth + 1));
		return;
	}
	for (const [key, item] of Object.entries(value as JsonRecord)) {
		const normalizedKey = key.toLowerCase();
		const childField = `${field}.${key}`;
		if (normalizedKey === "script" || normalizedKey === "code" || normalizedKey === "source") {
			throw invalidDesired("preNavigationHooks cannot include executable script/code/source fields", { field: childField, forbiddenField: key });
		}
		assertNoPreNavigationExecutableFields(item, childField, depth + 1);
	}
}

function preNavigationHooksEnabled(value: unknown): boolean {
	if (value === undefined || value === null || value === false) return false;
	if (Array.isArray(value)) return value.some((item) => preNavigationHooksEnabled(item));
	if (isRecord(value) && value.enabled === false) return false;
	return true;
}

function assertPreNavigationHooksDesignOnly(value: unknown, field: string): void {
	assertNoPreNavigationExecutableFields(value, field);
	if (!preNavigationHooksEnabled(value)) return;
	throw invalidDesired("preNavigationHooks is design-only until TODO229 runtime implementation", { field, supportedAfter: "TODO229" });
}

function normalizeNetworkRecorder(value: unknown, sessionTag: string): NormalizedNetworkRecorder | undefined {
	if (value === undefined || value === false || value === null) return undefined;
	if (value === true) return { enabled: true, startBeforeNavigate: false, required: true, config: {} };
	if (!isRecord(value)) throw invalidDesired("networkRecorder must be boolean or object", { sessionTag, field: "networkRecorder" });
	const enabled = booleanField(value.enabled, true, "networkRecorder.enabled");
	if (!enabled) return undefined;
	const sessionId = stringField(value.sessionId ?? value.session_id, "networkRecorder.sessionId");
	return {
		enabled: true,
		sessionId,
		startBeforeNavigate: booleanField(value.startBeforeNavigate, false, "networkRecorder.startBeforeNavigate"),
		required: booleanField(value.required, true, "networkRecorder.required"),
		config: passThroughConfig(value, ["captureBodies", "capture_bodies", "captureRequestPostData", "includeWebSocketFrames", "includeSse", "maxEntries", "maxAgeMs", "maxBodyBytes", "clear", "storeHeaders", "resourceTypes", "includeUrls", "excludeUrls", "methods", "statuses"]),
	};
}

function normalizeHookDispatcher(value: unknown, sessionTag: string): NormalizedHookDispatcher | undefined {
	if (value === undefined || value === false || value === null) return undefined;
	if (value === true) return { enabled: true, required: true, force: true };
	if (!isRecord(value)) throw invalidDesired("hookDispatcher must be boolean or object", { sessionTag, field: "hookDispatcher" });
	const enabled = booleanField(value.enabled, true, "hookDispatcher.enabled");
	if (!enabled) return undefined;
	return {
		enabled: true,
		sessionId: stringField(value.sessionId ?? value.session_id, "hookDispatcher.sessionId"),
		required: booleanField(value.required, true, "hookDispatcher.required"),
		targets: value.targets,
		options: value.options,
		bufferSize: numberField(value.bufferSize ?? value.buffer_size, undefined, "hookDispatcher.bufferSize", 1, 100_000),
		force: booleanField(value.force, true, "hookDispatcher.force"),
		expectedVersion: stringField(value.expectedVersion ?? value.expected_version, "hookDispatcher.expectedVersion"),
		installFingerprint: stringField(value.installFingerprint ?? value.install_fingerprint, "hookDispatcher.installFingerprint"),
	};
}

function normalizeWindowState(value: unknown, field: string): NormalizedOwnedWindow["state"] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const state = String(value).trim();
	if (state === "normal" || state === "minimized" || state === "maximized" || state === "fullscreen") return state;
	throw invalidDesired(`${field} must be one of normal, minimized, maximized, fullscreen`, { field, value });
}

function normalizeOwnedWindow(value: unknown, sessionTag: string): NormalizedOwnedWindow {
	if (value === undefined || value === false || value === null) return { enabled: false, focused: true, closeOnDelete: true };
	if (value === true) return { enabled: true, focused: true, closeOnDelete: true };
	if (!isRecord(value)) throw invalidDesired("ownedWindow/windowIsolation must be boolean or object", { sessionTag, field: "ownedWindow" });
	const enabled = booleanField(value.enabled, true, "ownedWindow.enabled");
	if (!enabled) return { enabled: false, focused: true, closeOnDelete: true };
	return {
		enabled: true,
		focused: booleanField(value.focused, true, "ownedWindow.focused"),
		state: normalizeWindowState(value.state, "ownedWindow.state"),
		left: numberField(value.left, undefined, "ownedWindow.left", -100_000, 100_000),
		top: numberField(value.top, undefined, "ownedWindow.top", -100_000, 100_000),
		width: numberField(value.width, undefined, "ownedWindow.width", 100, 100_000),
		height: numberField(value.height, undefined, "ownedWindow.height", 100, 100_000),
		closeOnDelete: booleanField(value.closeOnDelete ?? value.close_on_delete, true, "ownedWindow.closeOnDelete"),
	};
}

function normalizeVisualGrouping(value: unknown, sessionTag: string): NormalizedVisualGrouping {
	if (value === undefined || value === false || value === null) return { enabled: false, required: false };
	if (value === true) return { enabled: true, required: false };
	if (!isRecord(value)) throw invalidDesired("visualGrouping must be boolean or object", { sessionTag, field: "visualGrouping" });
	const enabled = booleanField(value.enabled, true, "visualGrouping.enabled");
	if (!enabled) return { enabled: false, required: false };
	return {
		enabled: true,
		title: stringField(value.title, "visualGrouping.title"),
		color: stringField(value.color, "visualGrouping.color"),
		collapsed: value.collapsed === undefined ? undefined : booleanField(value.collapsed, false, "visualGrouping.collapsed"),
		required: false,
	};
}

function deriveAllowedOrigins(input: BrowserOrchestrationDesiredInput): Set<string> {
	if (Array.isArray(input.allowedOrigins) && input.allowedOrigins.length) return new Set(input.allowedOrigins.map((item, index) => originFromInput(item, `allowedOrigins[${index}]`)));
	const origins = new Set<string>();
	const sessions = Array.isArray(input.sessions) ? input.sessions as BrowserDesiredSessionInput[] : [];
	for (const session of sessions) {
		if (!isRecord(session)) continue;
		for (const url of [session.url, ...(Array.isArray(session.tabs) ? (session.tabs as BrowserDesiredTabInput[]).map((tab) => isRecord(tab) ? tab.url : undefined) : []), ...(Array.isArray(session.cookies) ? (session.cookies as BrowserDesiredCookieInput[]).map((cookie) => isRecord(cookie) ? cookie.url : undefined) : [])]) {
			if (url === undefined || url === null || url === "") continue;
			origins.add(normalizeHttpUrl(url, "desired.url").origin);
		}
	}
	return origins;
}

export function normalizeDesired(input: unknown): NormalizedBrowserOrchestrationDesired {
	if (!isRecord(input)) throw invalidDesired("desiredState must be an object", { field: "desiredState" });
	const desiredInput = input as BrowserOrchestrationDesiredInput;
	const apiVersion = stringField(desiredInput.apiVersion ?? "pi.browser/v1", "apiVersion", { required: true });
	if (apiVersion !== "pi.browser/v1") throw invalidDesired("apiVersion must be pi.browser/v1", { apiVersion });
	const defaultsRaw = isRecord(desiredInput.defaults) ? desiredInput.defaults : {};
	const defaults = {
		timeoutMs: numberField(defaultsRaw.timeoutMs, DEFAULT_TIMEOUT_MS, "defaults.timeoutMs", 100, 10 * 60_000) || DEFAULT_TIMEOUT_MS,
		navigationTimeoutMs: numberField(defaultsRaw.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS, "defaults.navigationTimeoutMs", 100, 10 * 60_000) || DEFAULT_NAVIGATION_TIMEOUT_MS,
		tabRole: stringField(defaultsRaw.tabRole ?? "main", "defaults.tabRole", { required: true, pattern: TAG_PATTERN }) || "main",
		cleanupOnFailure: booleanField(defaultsRaw.cleanupOnFailure, true, "defaults.cleanupOnFailure"),
	};
	const isolationRaw = isRecord(desiredInput.isolation) ? desiredInput.isolation : {};
	const scope = isolationRaw.scope === undefined ? "logical" : String(isolationRaw.scope);
	if (scope !== "logical" && scope !== "browser") throw invalidDesired("isolation.scope must be logical or browser", { field: "isolation.scope", value: isolationRaw.scope });
	const isolation = {
		scope,
		ownedTabsOnly: booleanField(isolationRaw.ownedTabsOnly, true, "isolation.ownedTabsOnly"),
		closeOwnedTabsOnDelete: booleanField(isolationRaw.closeOwnedTabsOnDelete, true, "isolation.closeOwnedTabsOnDelete"),
	};
	const browserRaw = isRecord(desiredInput.browser) ? desiredInput.browser : {};
	const browserId = stringField(browserRaw.browserId, "browser.browserId");
	if (browserId && browserId !== "selected" && browserId !== "auto" && !TAG_PATTERN.test(browserId)) throw invalidDesired("browser.browserId contains unsupported characters", { browserId });
	if (browserRaw.crossBrowserFallback !== undefined && browserRaw.crossBrowserFallback !== false) throw invalidDesired("browser.crossBrowserFallback must be false", { field: "browser.crossBrowserFallback" });
	const browser = {
		browserId: browserId === "auto" ? undefined : browserId,
		requireSelected: booleanField(browserRaw.requireSelected, false, "browser.requireSelected"),
		crossBrowserFallback: false as const,
	};
	assertPreNavigationHooksDesignOnly(desiredInput.preNavigationHooks, "preNavigationHooks");
	const allowedOrigins = deriveAllowedOrigins(desiredInput);
	const defaultOwnedWindow = normalizeOwnedWindow(desiredInput.windowIsolation, "*");
	const defaultVisualGrouping = normalizeVisualGrouping(desiredInput.visualGrouping, "*");
	const sessionsInput = Array.isArray(desiredInput.sessions) ? desiredInput.sessions as BrowserDesiredSessionInput[] : undefined;
	if (!sessionsInput?.length) throw invalidDesired("desiredState.sessions must be a non-empty array", { field: "sessions" });
	const seenTags = new Set<string>();
	const sessions: NormalizedDesiredSession[] = sessionsInput.map((session, index) => {
		if (!isRecord(session)) throw invalidDesired("sessions entries must be objects", { index });
		const tag = stringField(session.tag, "session.tag", { required: true, pattern: TAG_PATTERN }) || "";
		if (seenTags.has(tag)) throw invalidDesired("session tags must be unique", { tag });
		seenTags.add(tag);
		assertPreNavigationHooksDesignOnly(session.preNavigationHooks, `sessions[${index}].preNavigationHooks`);
		const tabs = normalizeTabs(tag, session, defaults, allowedOrigins);
		const cookies = Array.isArray(session.cookies) ? (session.cookies as BrowserDesiredCookieInput[]).map((cookie, cookieIndex) => normalizeCookie(tag, cookie, tabs, allowedOrigins, cookieIndex)) : [];
		if (!tabs.length && (session.networkRecorder || session.hookDispatcher)) throw invalidDesired("networkRecorder and hookDispatcher require at least one desired tab", { tag });
		if (!tabs.length && !cookies.length) throw invalidDesired("session requires tabs, url, or cookies", { tag });
		return {
			tag,
			required: booleanField(session.required, true, "session.required"),
			tabs,
			cookies,
			ownedWindow: session.ownedWindow === undefined ? defaultOwnedWindow : normalizeOwnedWindow(session.ownedWindow, tag),
			visualGrouping: session.visualGrouping === undefined ? defaultVisualGrouping : normalizeVisualGrouping(session.visualGrouping, tag),
			networkRecorder: normalizeNetworkRecorder(session.networkRecorder, tag),
			hookDispatcher: normalizeHookDispatcher(session.hookDispatcher, tag),
		};
	});
	const ttlMs = numberField(desiredInput.ttlMs, undefined, "ttlMs", 1_000, 24 * 60 * 60_000);
	const withoutDigest = {
		apiVersion: "pi.browser/v1" as const,
		orchestrationId: stringField(desiredInput.orchestrationId, "orchestrationId", { pattern: TAG_PATTERN }) || `orch-${randomUUID()}`,
		generation: stringField(desiredInput.generation, "generation", { pattern: TAG_PATTERN }) || "",
		desiredHash: "",
		browser,
		defaults,
		isolation,
		allowedOrigins: Array.from(allowedOrigins).sort(),
		ttlMs,
		sessions,
	};
	const desiredHash = hashSensitiveString(stableJson(withoutDigest));
	return { ...withoutDigest, generation: withoutDigest.generation || `g-${shortHash(desiredHash)}`, desiredHash };
}
