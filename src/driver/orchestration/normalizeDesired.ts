import { randomUUID } from "node:crypto";
import { invalidDesired } from "./orchestrationErrors";
import { preNavigationHookKey, resolvePreNavigationHook } from "./preNavigationHooks";
import { hashSensitiveString, shortHash, stableJson } from "./orchestrationRedaction";
import type {
	BrowserDesiredAssertionInput,
	BrowserDesiredCookieInput,
	BrowserOrchestrationAdoptionInput,
	BrowserDesiredPreNavigationHookInput,
	BrowserDesiredSessionAssertionsInput,
	BrowserDesiredSessionInput,
	BrowserDesiredTabInput,
	BrowserOrchestrationDesiredInput,
	BrowserOrchestrationProfileIsolationInput,
	JsonRecord,
	NormalizedBrowserOrchestrationDesired,
	NormalizedDesiredCookie,
	NormalizedDesiredSession,
	NormalizedDesiredTab,
	NormalizedHookDispatcher,
	NormalizedNetworkRecorder,
	NormalizedPreNavigationHookMetadata,
	NormalizedPreNavigationHookScope,
	NormalizedOwnedWindow,
	NormalizedSessionAssertion,
	NormalizedSessionAssertions,
	NormalizedVisualGrouping,
	OrchestrationAdoptionPolicy,
	OrchestrationPersistenceResourceType,
} from "./types";

const TAG_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const HEX64_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const ADOPTION_RESOURCE_TYPES = new Set<OrchestrationPersistenceResourceType>(["tab", "window", "networkRecorder", "hookDispatcher", "preNavigationHook", "cookie"]);

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

function normalizeStringArray(value: unknown, field: string, options: { pattern?: RegExp } = {}): string[] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const raw = Array.isArray(value) ? value : [value];
	const out = raw.map((item, index) => stringField(item, `${field}[${index}]`, { required: true, pattern: options.pattern }) || "");
	const unique = Array.from(new Set(out.filter(Boolean)));
	return unique.length ? unique : undefined;
}
function normalizeNumberArray(value: unknown, field: string): number[] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const raw = Array.isArray(value) ? value : [value];
	const out = raw.map((item, index) => numberField(item, undefined, `${field}[${index}]`, 0, Number.MAX_SAFE_INTEGER));
	const unique = Array.from(new Set(out.filter((item): item is number => item !== undefined)));
	return unique.length ? unique : undefined;
}

function normalizeProfileIsolation(value: unknown): import("./types").NormalizedOrchestrationProfileIsolation | undefined {
	if (!isRecord(value)) throw invalidDesired("isolation.profile is required when isolation.scope is profile", { field: "isolation.profile" });
	const raw = value as BrowserOrchestrationProfileIsolationInput;
	const profileId = stringField(raw.profileId, "isolation.profile.profileId", { required: true, pattern: TAG_PATTERN }) || "";
	const lifecycle = raw.lifecycle === undefined ? "managed" : String(raw.lifecycle);
	if (lifecycle !== "managed") throw invalidDesired("isolation.profile.lifecycle must be managed", { field: "isolation.profile.lifecycle", value: raw.lifecycle });
	const reuse = raw.reuse === undefined ? "owned" : String(raw.reuse);
	if (reuse !== "none" && reuse !== "owned") throw invalidDesired("isolation.profile.reuse must be none or owned", { field: "isolation.profile.reuse", value: raw.reuse });
	const cleanup = raw.cleanup === undefined ? "delete" : String(raw.cleanup);
	if (cleanup !== "delete" && cleanup !== "keepOnFailure") throw invalidDesired("isolation.profile.cleanup must be delete or keepOnFailure", { field: "isolation.profile.cleanup", value: raw.cleanup });
	return { profileId, lifecycle: "managed", reuse: reuse as "none" | "owned", cleanup: cleanup as "delete" | "keepOnFailure" };
}

function normalizeResourceTypes(value: unknown, field: string): OrchestrationPersistenceResourceType[] {
	const raw = normalizeStringArray(value, field) || [];
	if (!raw.length) throw invalidDesired(`${field} must be a non-empty array`, { field });
	return raw.map((item) => {
		if (!ADOPTION_RESOURCE_TYPES.has(item as OrchestrationPersistenceResourceType)) throw invalidDesired(`${field} contains unsupported resource type`, { field, value: item });
		return item as OrchestrationPersistenceResourceType;
	});
}

function normalizeAdoption(value: unknown, orchestrationId: string): OrchestrationAdoptionPolicy | undefined {
	if (value === undefined || value === null || value === false) return undefined;
	if (!isRecord(value)) throw invalidDesired("adoption must be an object", { field: "adoption" });
	const raw = value as BrowserOrchestrationAdoptionInput;
	if (raw.enabled !== true) throw invalidDesired("adoption.enabled must be true when adoption is supplied", { field: "adoption.enabled" });
	const adoptionId = stringField(raw.orchestrationId, "adoption.orchestrationId", { required: true, pattern: TAG_PATTERN }) || "";
	if (adoptionId !== orchestrationId) throw invalidDesired("adoption.orchestrationId must match desiredState.orchestrationId", { field: "adoption.orchestrationId", orchestrationId, adoptionOrchestrationId: adoptionId });
	const verifyOrigins = normalizeStringArray(raw.verifyOrigins, "adoption.verifyOrigins")?.map((origin, index) => originFromInput(origin, `adoption.verifyOrigins[${index}]`)) || [];
	const verifyUrls = normalizeStringArray(raw.verifyUrls, "adoption.verifyUrls")?.map((url, index) => normalizeHttpUrl(url, `adoption.verifyUrls[${index}]`).url) || [];
	if (!verifyOrigins.length) throw invalidDesired("adoption.verifyOrigins must be a non-empty array", { field: "adoption.verifyOrigins" });
	if (!verifyUrls.length) throw invalidDesired("adoption.verifyUrls must be a non-empty array", { field: "adoption.verifyUrls" });
	return {
		enabled: true,
		orchestrationId: adoptionId,
		resourceTypes: normalizeResourceTypes(raw.resourceTypes, "adoption.resourceTypes"),
		verifyOrigins: Array.from(new Set(verifyOrigins)).sort(),
		verifyUrls: Array.from(new Set(verifyUrls)).sort(),
		verifyBrowserIds: normalizeStringArray(raw.verifyBrowserIds, "adoption.verifyBrowserIds", { pattern: TAG_PATTERN }),
		verifyWindowIds: normalizeNumberArray(raw.verifyWindowIds, "adoption.verifyWindowIds"),
		verifyProfileIds: normalizeStringArray(raw.verifyProfileIds, "adoption.verifyProfileIds", { pattern: TAG_PATTERN }),
		requireOwnedFingerprint: booleanField(raw.requireOwnedFingerprint, true, "adoption.requireOwnedFingerprint"),
	};
}


function normalizePreNavigationHookScope(value: unknown, field: string, allowedOrigins: Set<string>): NormalizedPreNavigationHookScope {
	if (value === undefined || value === null) return { allFrames: true, matchAboutBlank: false };
	if (!isRecord(value)) throw invalidDesired(`${field} must be an object`, { field });
	const origins = normalizeStringArray(value.origins, `${field}.origins`)?.map((origin, index) => {
		const normalized = originFromInput(origin, `${field}.origins[${index}]`);
		assertAllowedOrigin(normalized, allowedOrigins, `${field}.origins[${index}]`);
		return normalized;
	});
	return {
		tabRoles: normalizeStringArray(value.tabRoles ?? value.tab_roles, `${field}.tabRoles`, { pattern: TAG_PATTERN }),
		origins,
		allFrames: booleanField(value.allFrames ?? value.all_frames, true, `${field}.allFrames`),
		matchAboutBlank: booleanField(value.matchAboutBlank ?? value.match_about_blank, false, `${field}.matchAboutBlank`),
	};
}

function normalizePreNavigationHooks(value: unknown, field: string, allowedOrigins: Set<string>): NormalizedPreNavigationHookMetadata[] {
	assertNoPreNavigationExecutableFields(value, field);
	if (value === undefined || value === null || value === false) return [];
	const rawItems = Array.isArray(value) ? value : [value];
	const hooks: NormalizedPreNavigationHookMetadata[] = [];
	for (const [index, raw] of rawItems.entries()) {
		if (raw === undefined || raw === null || raw === false) continue;
		if (!isRecord(raw)) throw invalidDesired(`${field}[${index}] must be an object`, { field: `${field}[${index}]` });
		if (raw.enabled === false && raw.hookId === undefined && raw.version === undefined && raw.hash === undefined) continue;
		const enabled = booleanField(raw.enabled, true, `${field}[${index}].enabled`);
		if (!enabled) continue;
		const hookId = stringField(raw.hookId, `${field}[${index}].hookId`, { required: true, pattern: TAG_PATTERN }) || "";
		const version = stringField(raw.version, `${field}[${index}].version`, { required: true, pattern: TAG_PATTERN }) || "";
		const hash = stringField(raw.hash, `${field}[${index}].hash`, { required: true }) || "";
		if (!/^sha256:[a-f0-9]{64}$/i.test(hash)) throw invalidDesired(`${field}[${index}].hash must be sha256:<64 hex chars>`, { field: `${field}[${index}].hash`, hookId, version });
		if (raw.params !== undefined && !isRecord(raw.params)) throw invalidDesired(`${field}[${index}].params must be an object`, { field: `${field}[${index}].params`, hookId, version });
		const normalized: NormalizedPreNavigationHookMetadata = {
			hookId,
			enabled: true,
			params: isRecord(raw.params) ? raw.params : {},
			scope: normalizePreNavigationHookScope(raw.scope, `${field}[${index}].scope`, allowedOrigins),
			version,
			hash,
			required: booleanField(raw.required, true, `${field}[${index}].required`),
			installPhase: "pre-navigation",
		};
		resolvePreNavigationHook(normalized);
		hooks.push(normalized);
	}
	const seen = new Set<string>();
	for (const hook of hooks) {
		const key = preNavigationHookKey(hook);
		if (seen.has(key)) throw invalidDesired("preNavigationHooks entries must be unique by hookId/version/hash", { field, hookId: hook.hookId, version: hook.version, hash: hook.hash });
		seen.add(key);
	}
	return hooks;
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

function assertionHashField(value: unknown, field: string): string | undefined {
	const out = stringField(value, field);
	if (!out) return undefined;
	if (!HEX64_PATTERN.test(out)) throw invalidDesired(`${field} must be a sha256 hex string`, { field, value: out });
	return out.toLowerCase();
}

function requireAssertionTabRole(sessionTag: string, tabs: NormalizedDesiredTab[], value: unknown, field: string): string {
	const role = stringField(value, field, { pattern: TAG_PATTERN }) || tabs[0]?.role;
	if (!role) throw invalidDesired("sessionAssertions require at least one desired tab", { sessionTag, field });
	if (!tabs.some((tab) => tab.role === role)) throw invalidDesired(`${field} must reference an existing desired tab role`, { sessionTag, field, tabRole: role, tabRoles: tabs.map((tab) => tab.role) });
	return role;
}

function normalizeSessionAssertions(value: unknown, sessionTag: string, tabs: NormalizedDesiredTab[], allowedOrigins: Set<string>): NormalizedSessionAssertions | undefined {
	if (value === undefined || value === null || value === false) return undefined;
	if (!isRecord(value)) throw invalidDesired("sessionAssertions must be an object", { sessionTag, field: "sessionAssertions" });
	const raw = value as BrowserDesiredSessionAssertionsInput;
	const modeRaw = raw.mode === undefined ? "all" : String(raw.mode).trim();
	if (modeRaw !== "all" && modeRaw !== "any") throw invalidDesired("sessionAssertions.mode must be all or any", { sessionTag, field: "sessionAssertions.mode", value: raw.mode });
	if (!Array.isArray(raw.checks) || raw.checks.length === 0) throw invalidDesired("sessionAssertions.checks must be a non-empty array", { sessionTag, field: "sessionAssertions.checks" });
	const seenIds = new Set<string>();
	const checks = raw.checks.map((item, index): NormalizedSessionAssertion => {
		if (!isRecord(item)) throw invalidDesired("sessionAssertions.checks entries must be objects", { sessionTag, field: `sessionAssertions.checks[${index}]` });
		const rawAssertion = item as BrowserDesiredAssertionInput;
		const id = stringField(rawAssertion.id, `sessionAssertions.checks[${index}].id`, { required: true, pattern: TAG_PATTERN }) || "";
		if (seenIds.has(id)) throw invalidDesired("sessionAssertions ids must be unique per session", { sessionTag, id });
		seenIds.add(id);
		const kind = stringField(rawAssertion.kind, `sessionAssertions.checks[${index}].kind`, { required: true }) || "";
		const tabRole = requireAssertionTabRole(sessionTag, tabs, rawAssertion.tabRole, `sessionAssertions.checks[${index}].tabRole`);
		switch (kind) {
			case "url": {
				const equals = rawAssertion.equals === undefined ? undefined : normalizeHttpUrl(rawAssertion.equals, `sessionAssertions.checks[${index}].equals`).url;
				if (equals) assertAllowedOrigin(new URL(equals).origin, allowedOrigins, `sessionAssertions.checks[${index}].equals`);
				const includes = stringField(rawAssertion.includes, `sessionAssertions.checks[${index}].includes`);
				if (!equals && !includes) throw invalidDesired("url assertion requires equals or includes", { sessionTag, id, kind });
				return { id, kind: "url", tabRole, equals, includes };
			}
			case "origin": {
				const equals = originFromInput(rawAssertion.equals, `sessionAssertions.checks[${index}].equals`);
				assertAllowedOrigin(equals, allowedOrigins, `sessionAssertions.checks[${index}].equals`);
				return { id, kind: "origin", tabRole, equals };
			}
			case "loadState": {
				const state = normalizeWaitUntil(rawAssertion.state);
				if (state === "none") throw invalidDesired("loadState assertion cannot use none", { sessionTag, id, field: `sessionAssertions.checks[${index}].state` });
				return { id, kind: "loadState", tabRole, state };
			}
			case "cookie": {
				const name = stringField(rawAssertion.name, `sessionAssertions.checks[${index}].name`, { required: true }) || "";
				const present = booleanField(rawAssertion.present, true, `sessionAssertions.checks[${index}].present`);
				const valueHash = assertionHashField(rawAssertion.valueHash, `sessionAssertions.checks[${index}].valueHash`);
				if (valueHash && !present) throw invalidDesired("cookie assertion cannot set valueHash when present is false", { sessionTag, id, kind });
				return { id, kind: "cookie", tabRole, name, present, valueHash };
			}
			case "storage": {
				const storageArea = stringField(rawAssertion.storageArea, `sessionAssertions.checks[${index}].storageArea`, { required: true }) || "";
				if (storageArea !== "localStorage" && storageArea !== "sessionStorage") throw invalidDesired("storage assertion storageArea must be localStorage or sessionStorage", { sessionTag, id, value: storageArea });
				const key = stringField(rawAssertion.key, `sessionAssertions.checks[${index}].key`, { required: true }) || "";
				const present = booleanField(rawAssertion.present, true, `sessionAssertions.checks[${index}].present`);
				const valueHash = assertionHashField(rawAssertion.valueHash, `sessionAssertions.checks[${index}].valueHash`);
				if (valueHash && !present) throw invalidDesired("storage assertion cannot set valueHash when present is false", { sessionTag, id, kind });
				return { id, kind: "storage", tabRole, storageArea: storageArea as "localStorage" | "sessionStorage", key, present, valueHash };
			}
			case "selector": {
				const selector = stringField(rawAssertion.selector, `sessionAssertions.checks[${index}].selector`, { required: true }) || "";
				const present = booleanField(rawAssertion.present, true, `sessionAssertions.checks[${index}].present`);
				return { id, kind: "selector", tabRole, selector, present };
			}
			case "text": {
				const selector = stringField(rawAssertion.selector, `sessionAssertions.checks[${index}].selector`);
				const includes = stringField(rawAssertion.includes, `sessionAssertions.checks[${index}].includes`);
				const equalsHash = assertionHashField(rawAssertion.equalsHash, `sessionAssertions.checks[${index}].equalsHash`);
				if (!includes && !equalsHash) throw invalidDesired("text assertion requires includes or equalsHash", { sessionTag, id, kind });
				return { id, kind: "text", tabRole, selector, includes, equalsHash };
			}
			case "attribute": {
				const selector = stringField(rawAssertion.selector, `sessionAssertions.checks[${index}].selector`, { required: true }) || "";
				const name = stringField(rawAssertion.name, `sessionAssertions.checks[${index}].name`, { required: true }) || "";
				const present = booleanField(rawAssertion.present, rawAssertion.equals === undefined && rawAssertion.equalsHash === undefined, `sessionAssertions.checks[${index}].present`);
				const equals = stringField(rawAssertion.equals, `sessionAssertions.checks[${index}].equals`);
				const equalsHash = assertionHashField(rawAssertion.equalsHash, `sessionAssertions.checks[${index}].equalsHash`);
				if (!present && (equals || equalsHash)) throw invalidDesired("attribute assertion cannot compare equals/equalsHash when present is false", { sessionTag, id, kind });
				if (!present && rawAssertion.equals === undefined && rawAssertion.equalsHash === undefined) return { id, kind: "attribute", tabRole, selector, name, present };
				if (present && !equals && !equalsHash && rawAssertion.present === undefined) throw invalidDesired("attribute assertion requires present, equals, or equalsHash", { sessionTag, id, kind });
				return { id, kind: "attribute", tabRole, selector, name, present, equals, equalsHash };
			}
			case "hook": {
				const state = rawAssertion.state === undefined ? "INSTALLED" : String(rawAssertion.state).trim().toUpperCase();
				if (state !== "INSTALLED") throw invalidDesired("hook assertion state must be INSTALLED", { sessionTag, id, kind, value: rawAssertion.state });
				return { id, kind: "hook", tabRole, sessionId: stringField(rawAssertion.sessionId ?? rawAssertion.session_id, `sessionAssertions.checks[${index}].sessionId`), state: "INSTALLED" };
			}
			case "networkRecorder": {
				const state = rawAssertion.state === undefined ? "running" : String(rawAssertion.state).trim();
				if (state !== "running") throw invalidDesired("networkRecorder assertion state must be running", { sessionTag, id, kind, value: rawAssertion.state });
				return { id, kind: "networkRecorder", tabRole, sessionId: stringField(rawAssertion.sessionId ?? rawAssertion.session_id, `sessionAssertions.checks[${index}].sessionId`), state: "running" };
			}
			case "profile": {
				const profileId = stringField(rawAssertion.profileId, `sessionAssertions.checks[${index}].profileId`, { pattern: TAG_PATTERN });
				const present = booleanField(rawAssertion.present, true, `sessionAssertions.checks[${index}].present`);
				return { id, kind: "profile", tabRole, profileId, present };
			}
			default:
				throw invalidDesired("sessionAssertions kind is not supported", { sessionTag, id, kind });
		}
	});
	return { mode: modeRaw as "all" | "any", checks };
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
	if (scope !== "logical" && scope !== "browser" && scope !== "profile") throw invalidDesired("isolation.scope must be logical, browser, or profile", { field: "isolation.scope", value: isolationRaw.scope });
	const profile = scope === "profile" ? normalizeProfileIsolation(isolationRaw.profile) : undefined;
	const isolation = {
		scope: scope as "logical" | "browser" | "profile",
		ownedTabsOnly: booleanField(isolationRaw.ownedTabsOnly, true, "isolation.ownedTabsOnly"),
		closeOwnedTabsOnDelete: booleanField(isolationRaw.closeOwnedTabsOnDelete, true, "isolation.closeOwnedTabsOnDelete"),
		profile,
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
	const allowedOrigins = deriveAllowedOrigins(desiredInput);
	const topLevelPreNavigationHooks = normalizePreNavigationHooks(desiredInput.preNavigationHooks, "preNavigationHooks", allowedOrigins);
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
		if (session.readinessChecks !== undefined) throw invalidDesired("readinessChecks is not supported as a desiredState field; use sessionAssertions only", { tag, field: `sessions[${index}].readinessChecks` });
		const sessionPreNavigationHooks = session.preNavigationHooks === undefined ? topLevelPreNavigationHooks : normalizePreNavigationHooks(session.preNavigationHooks, `sessions[${index}].preNavigationHooks`, allowedOrigins);
		const tabs = normalizeTabs(tag, session, defaults, allowedOrigins);
		const cookies = Array.isArray(session.cookies) ? (session.cookies as BrowserDesiredCookieInput[]).map((cookie, cookieIndex) => normalizeCookie(tag, cookie, tabs, allowedOrigins, cookieIndex)) : [];
		const sessionAssertions = normalizeSessionAssertions(session.sessionAssertions, tag, tabs, allowedOrigins);
		if (!tabs.length && (session.networkRecorder || session.hookDispatcher || session.sessionAssertions)) throw invalidDesired("networkRecorder, hookDispatcher, and sessionAssertions require at least one desired tab", { tag });
		if (!tabs.length && !cookies.length) throw invalidDesired("session requires tabs, url, or cookies", { tag });
		return {
			tag,
			required: booleanField(session.required, true, "session.required"),
			tabs,
			cookies,
			ownedWindow: session.ownedWindow === undefined ? defaultOwnedWindow : normalizeOwnedWindow(session.ownedWindow, tag),
			visualGrouping: session.visualGrouping === undefined ? defaultVisualGrouping : normalizeVisualGrouping(session.visualGrouping, tag),
			preNavigationHooks: sessionPreNavigationHooks,
			networkRecorder: normalizeNetworkRecorder(session.networkRecorder, tag),
			hookDispatcher: normalizeHookDispatcher(session.hookDispatcher, tag),
			sessionAssertions,
		};
	});
	if (isolation.scope === "profile" && !sessions.some((session) => session.tabs.length > 0)) throw invalidDesired("isolation.scope profile requires at least one desired tab", { field: "isolation.scope" });
	const ttlMs = numberField(desiredInput.ttlMs, undefined, "ttlMs", 1_000, 24 * 60 * 60_000);
	const orchestrationId = stringField(desiredInput.orchestrationId, "orchestrationId", { pattern: TAG_PATTERN }) || `orch-${randomUUID()}`;
	const adoption = normalizeAdoption(desiredInput.adoption, orchestrationId);
	const withoutDigest = {
		apiVersion: "pi.browser/v1" as const,
		orchestrationId,
		generation: stringField(desiredInput.generation, "generation", { pattern: TAG_PATTERN }) || "",
		desiredHash: "",
		browser,
		defaults,
		isolation,
		allowedOrigins: Array.from(allowedOrigins).sort(),
		ttlMs,
		sessions,
		adoption,
	};
	const desiredHash = hashSensitiveString(stableJson(withoutDigest));
	return { ...withoutDigest, generation: withoutDigest.generation || `g-${shortHash(desiredHash)}`, desiredHash };
}
