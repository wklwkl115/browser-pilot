import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { bindingKey, OrchestrationStore } from "./OrchestrationStore";
import { hashSensitiveString, stableJson } from "./orchestrationRedaction";
import type {
	JsonRecord,
	OrchestrationBinding,
	OrchestrationPersistedBinding,
	OrchestrationPersistedCookieFingerprint,
	OrchestrationPersistedRecord,
	OrchestrationPersistedResourceFingerprint,
	OrchestrationPersistedStateFile,
	OrchestrationPersistenceStatus,
	OrchestrationPersistenceMode,
	OrchestrationRuntimeState,
	PreNavigationHookRegistration,
} from "./types";

const SCHEMA_VERSION = "pi.browser.orchestration.state/v1" as const;
const PRIVACY = {
	classification: "local_redacted_orchestration_state" as const,
	localOnly: true as const,
	redaction: "required" as const,
	cleanup: "rm -rf .pi/browser-artifacts/orchestration-state",
};
const PERSISTENCE_STATUS = new Set<OrchestrationPersistenceStatus>(["current", "stale", "read_only", "adoption_required", "adopted"]);

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function sanitizePreNavigationHooks(value: unknown): PreNavigationHookRegistration[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const hooks = value.filter(isRecord).map((hook) => ({
		hookId: stringValue(hook.hookId) || "",
		version: stringValue(hook.version) || "",
		hash: stringValue(hook.hash) || "",
		identifier: stringValue(hook.identifier) || "",
		sessionKey: stringValue(hook.sessionKey),
		cdpSessionName: stringValue(hook.cdpSessionName) || "",
		sessionTag: stringValue(hook.sessionTag) || "",
		tabRole: stringValue(hook.tabRole) || "",
		installedAt: numberValue(hook.installedAt) || Date.now(),
		effectVerifiedAt: numberValue(hook.effectVerifiedAt),
		workerBootId: stringValue(hook.workerBootId),
	})).filter((hook) => hook.hookId && hook.version && hook.hash && hook.identifier && hook.cdpSessionName && hook.sessionTag && hook.tabRole);
	return hooks.length ? hooks : undefined;
}

function sanitizeBinding(value: unknown): OrchestrationBinding | undefined {
	if (!isRecord(value)) return undefined;
	const sessionTag = stringValue(value.sessionTag);
	const tabRole = stringValue(value.tabRole);
	const browserId = stringValue(value.browserId);
	const tabId = numberValue(value.tabId);
	if (!sessionTag || !tabRole || !browserId || tabId === undefined) return undefined;
	return {
		sessionTag,
		tabRole,
		browserId,
		browserExtensionId: stringValue(value.browserExtensionId),
		tabId,
		windowId: numberValue(value.windowId),
			windowOwned: booleanValue(value.windowOwned),
			windowCloseOnDelete: booleanValue(value.windowCloseOnDelete),
			groupId: numberValue(value.groupId),
			profileId: stringValue(value.profileId),
			tabGroupsStatus: stringValue(value.tabGroupsStatus) as OrchestrationBinding["tabGroupsStatus"],
		owned: value.owned === true,
		desiredUrl: stringValue(value.desiredUrl) || "about:blank",
		createdByOrchestrator: value.createdByOrchestrator === true,
		createdAt: numberValue(value.createdAt) || Date.now(),
		updatedAt: numberValue(value.updatedAt) || Date.now(),
		networkSessionId: stringValue(value.networkSessionId),
		networkConfigHash: stringValue(value.networkConfigHash),
		hookSessionId: stringValue(value.hookSessionId),
		hookFingerprint: stringValue(value.hookFingerprint),
		preNavigationHooks: sanitizePreNavigationHooks(value.preNavigationHooks),
		workerBootId: stringValue(value.workerBootId),
	};
}

function sanitizeFingerprint(value: unknown): OrchestrationPersistedResourceFingerprint | undefined {
	if (!isRecord(value)) return undefined;
	const sessionTag = stringValue(value.sessionTag);
	const tabRole = stringValue(value.tabRole);
	if (!sessionTag || !tabRole) return undefined;
	return {
		sessionTag,
		tabRole,
		browserId: stringValue(value.browserId),
		browserExtensionId: stringValue(value.browserExtensionId),
		tabId: numberValue(value.tabId),
		windowId: numberValue(value.windowId),
		profileId: stringValue(value.profileId),
		origin: stringValue(value.origin),
		url: stringValue(value.url),
		desiredUrl: stringValue(value.desiredUrl),
		workerBootId: stringValue(value.workerBootId),
		networkSessionId: stringValue(value.networkSessionId),
		networkConfigHash: stringValue(value.networkConfigHash),
		hookSessionId: stringValue(value.hookSessionId),
		hookFingerprint: stringValue(value.hookFingerprint),
		preNavigationHookHashes: Array.isArray(value.preNavigationHookHashes) ? value.preNavigationHookHashes.map(stringValue).filter((item): item is string => !!item) : undefined,
		cookieKeys: Array.isArray(value.cookieKeys) ? value.cookieKeys.map(stringValue).filter((item): item is string => !!item) : undefined,
		owned: booleanValue(value.owned),
		createdByOrchestrator: booleanValue(value.createdByOrchestrator),
	};
}

function sanitizePersistedBinding(value: unknown): OrchestrationPersistedBinding | undefined {
	const binding = sanitizeBinding(value);
	if (!binding) return undefined;
	return { ...binding, fingerprint: sanitizeFingerprint(isRecord(value) ? value.fingerprint : undefined) || fingerprintForBinding(binding, []) };
}

function sanitizeCookieFingerprint(value: unknown): OrchestrationPersistedCookieFingerprint | undefined {
	if (!isRecord(value)) return undefined;
	const key = stringValue(value.key);
	const sessionTag = stringValue(value.sessionTag);
	const tabRole = stringValue(value.tabRole);
	const origin = stringValue(value.origin);
	const name = stringValue(value.name);
	if (!key || !sessionTag || !tabRole || !origin || !name) return undefined;
	return {
		key,
		sessionTag,
		tabRole,
		origin,
		name,
		action: value.action === "remove" ? "remove" : "set",
		domain: stringValue(value.domain),
		path: stringValue(value.path),
		storeId: stringValue(value.storeId),
		partitionKeyHash: stringValue(value.partitionKeyHash),
		secure: booleanValue(value.secure),
		httpOnly: booleanValue(value.httpOnly),
		sameSite: stringValue(value.sameSite) as OrchestrationPersistedCookieFingerprint["sameSite"],
		expirationDate: numberValue(value.expirationDate),
		valueHash: stringValue(value.valueHash),
		valuePresent: booleanValue(value.valuePresent),
	};
}

function sanitizePersistedRecord(value: unknown): OrchestrationPersistedRecord | undefined {
	if (!isRecord(value)) return undefined;
	const orchestrationId = stringValue(value.orchestrationId);
	if (!orchestrationId) return undefined;
	const bindings = Array.isArray(value.bindings) ? value.bindings.map(sanitizePersistedBinding).filter((item): item is OrchestrationPersistedBinding => !!item) : [];
	const cookies = Array.isArray(value.cookies) ? value.cookies.map(sanitizeCookieFingerprint).filter((item): item is OrchestrationPersistedCookieFingerprint => !!item) : [];
	const fingerprints = Array.isArray(value.fingerprints) ? value.fingerprints.map(sanitizeFingerprint).filter((item): item is OrchestrationPersistedResourceFingerprint => !!item) : bindings.map((binding) => binding.fingerprint);
	const status = PERSISTENCE_STATUS.has(value.status as OrchestrationPersistenceStatus) ? value.status as OrchestrationPersistenceStatus : "current";
	return {
		orchestrationId,
		generation: stringValue(value.generation) || "persisted",
		desiredHash: stringValue(value.desiredHash) || "",
		createdAt: numberValue(value.createdAt) || Date.now(),
		updatedAt: numberValue(value.updatedAt) || Date.now(),
		deletedAt: numberValue(value.deletedAt),
		cleanupOnFailure: booleanValue(value.cleanupOnFailure),
		closeOwnedTabsOnDelete: booleanValue(value.closeOwnedTabsOnDelete),
		redactedDesired: redactUnknown(value.redactedDesired),
		bindings,
		cookies,
		fingerprints,
		status,
		readOnly: value.readOnly === true,
		adoptionRequired: value.adoptionRequired === true,
		adoptedAt: numberValue(value.adoptedAt),
	};
}

function redactUnknown(value: unknown, depth = 0, keyHint = ""): unknown {
	if (depth > 12) return "[MaxDepth]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		if (/hash$/i.test(keyHint)) return value;
		if (/cookie|token|authorization|password|secret|body|postdata|payload|websocket|script|code|source|value/i.test(keyHint)) return "[REDACTED]";
		return value.length > 500 ? `${value.slice(0, 500)}…` : value;
	}
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactUnknown(item, depth + 1, keyHint));
	const out: JsonRecord = {};
	for (const [key, item] of Object.entries(value as JsonRecord)) {
		if (/script|code|source/i.test(key)) continue;
		out[key] = redactUnknown(item, depth + 1, key);
	}
	return out;
}

function desiredSessions(redactedDesired: unknown): JsonRecord[] {
	return isRecord(redactedDesired) && Array.isArray(redactedDesired.sessions) ? redactedDesired.sessions.filter(isRecord) : [];
}

function cookieFingerprints(redactedDesired: unknown): OrchestrationPersistedCookieFingerprint[] {
	const cookies: OrchestrationPersistedCookieFingerprint[] = [];
	for (const session of desiredSessions(redactedDesired)) {
		const sessionTag = stringValue(session.tag) || "";
		const rawCookies = Array.isArray(session.cookies) ? session.cookies.filter(isRecord) : [];
		for (const cookie of rawCookies) {
			const key = stringValue(cookie.key);
			const name = stringValue(cookie.name);
			const origin = stringValue(cookie.origin);
			const tabRole = stringValue(cookie.tabRole) || "main";
			const action = cookie.action === "remove" ? "remove" : "set";
			if (!key || !name || !origin || !sessionTag) continue;
			cookies.push({
				key,
				sessionTag,
				tabRole,
				origin,
				name,
				action,
				domain: stringValue(cookie.domain),
				path: stringValue(cookie.path),
				storeId: stringValue(cookie.storeId),
				partitionKeyHash: cookie.partitionKey === undefined ? undefined : hashSensitiveString(stableJson(redactUnknown(cookie.partitionKey, 0, "partitionKey"))),
				secure: booleanValue(cookie.secure),
				httpOnly: booleanValue(cookie.httpOnly),
				sameSite: stringValue(cookie.sameSite) as OrchestrationPersistedCookieFingerprint["sameSite"],
				expirationDate: numberValue(cookie.expirationDate),
				valueHash: stringValue(cookie.valueHash),
				valuePresent: booleanValue(cookie.valuePresent),
			});
		}
	}
	return cookies;
}

function originOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try { return new URL(url).origin; }
	catch { return undefined; }
}

function fingerprintForBinding(binding: OrchestrationBinding, cookies: OrchestrationPersistedCookieFingerprint[]): OrchestrationPersistedResourceFingerprint {
	const cookieKeys = cookies.filter((cookie) => cookie.sessionTag === binding.sessionTag && cookie.tabRole === binding.tabRole).map((cookie) => cookie.key);
	return {
		sessionTag: binding.sessionTag,
		tabRole: binding.tabRole,
		browserId: binding.browserId,
		browserExtensionId: binding.browserExtensionId,
			tabId: binding.tabId,
			windowId: binding.windowId,
			profileId: binding.profileId,
			origin: originOf(binding.desiredUrl),
		url: binding.desiredUrl,
		desiredUrl: binding.desiredUrl,
		workerBootId: binding.workerBootId,
		networkSessionId: binding.networkSessionId,
		networkConfigHash: binding.networkConfigHash,
		hookSessionId: binding.hookSessionId,
		hookFingerprint: binding.hookFingerprint,
		preNavigationHookHashes: binding.preNavigationHooks?.map((hook) => hook.hash),
		cookieKeys: cookieKeys.length ? cookieKeys : undefined,
		owned: binding.owned,
		createdByOrchestrator: binding.createdByOrchestrator,
	};
}

function persistedBinding(binding: OrchestrationBinding, cookies: OrchestrationPersistedCookieFingerprint[]): OrchestrationPersistedBinding {
	return {
		sessionTag: binding.sessionTag,
		tabRole: binding.tabRole,
		browserId: binding.browserId,
		browserExtensionId: binding.browserExtensionId,
		tabId: binding.tabId,
		windowId: binding.windowId,
		windowOwned: binding.windowOwned,
			windowCloseOnDelete: binding.windowCloseOnDelete,
			groupId: binding.groupId,
			profileId: binding.profileId,
			tabGroupsStatus: binding.tabGroupsStatus,
		owned: binding.owned,
		createdByOrchestrator: binding.createdByOrchestrator,
		desiredUrl: binding.desiredUrl,
		createdAt: binding.createdAt,
		updatedAt: binding.updatedAt,
		networkSessionId: binding.networkSessionId,
		networkConfigHash: binding.networkConfigHash,
		hookSessionId: binding.hookSessionId,
		hookFingerprint: binding.hookFingerprint,
		preNavigationHooks: binding.preNavigationHooks?.map((hook) => ({ ...hook })),
		workerBootId: binding.workerBootId,
		fingerprint: fingerprintForBinding(binding, cookies),
	};
}

function persistedRecord(state: OrchestrationRuntimeState): OrchestrationPersistedRecord {
	const redactedDesired = redactUnknown(state.redactedDesired);
	const cookies = cookieFingerprints(redactedDesired);
	const bindings = state.bindings.map((binding) => persistedBinding(binding, cookies));
	return {
		orchestrationId: state.orchestrationId,
		generation: state.generation,
		desiredHash: state.desiredHash,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		deletedAt: state.deletedAt,
		cleanupOnFailure: state.cleanupOnFailure,
		closeOwnedTabsOnDelete: state.closeOwnedTabsOnDelete,
		redactedDesired,
		bindings,
		cookies,
		fingerprints: bindings.map((binding) => binding.fingerprint),
		status: state.persistence?.status === "adopted" ? "adopted" : state.persistence?.status === "current" ? "current" : "current",
		readOnly: false,
		adoptionRequired: false,
		adoptedAt: state.persistence?.adoptedAt,
	};
}

function validateStateFile(value: unknown): OrchestrationPersistedStateFile | undefined {
	if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.orchestrations)) return undefined;
	return value as OrchestrationPersistedStateFile;
}

export type PersistentOrchestrationStoreOptions = {
	cwd?: string;
	statePath?: string;
	driverRunId?: string;
	piSessionId?: string;
};

export class PersistentOrchestrationStore {
	readonly statePath: string;
	readonly driverRunId: string;
	readonly piSessionId: string;

	constructor(options: PersistentOrchestrationStoreOptions = {}) {
		const cwd = options.cwd || process.cwd();
		this.statePath = options.statePath || path.join(cwd, ".pi", "browser-artifacts", "orchestration-state", "state.v1.json");
		this.driverRunId = options.driverRunId || process.env.PI_BROWSER_DRIVER_RUN_ID || randomUUID();
		this.piSessionId = options.piSessionId || process.env.PI_BROWSER_PI_SESSION_ID || process.env.PI_SESSION_ID || "unknown";
	}

	async loadInto(store: OrchestrationStore): Promise<{ loaded: number; path: string; stale: boolean; ignored?: boolean; error?: string }> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.statePath, "utf8"));
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "ENOENT") return { loaded: 0, path: this.statePath, stale: false, ignored: true };
			return { loaded: 0, path: this.statePath, stale: false, ignored: true, error: error instanceof Error ? error.message : String(error) };
		}
		const file = validateStateFile(parsed);
		if (!file) return { loaded: 0, path: this.statePath, stale: false, ignored: true, error: "invalid orchestration persistence schema" };
		const stale = file.driverRunId !== this.driverRunId || file.piSessionId !== this.piSessionId || this.piSessionId === "unknown";
		let loaded = 0;
		for (const rawRecord of file.orchestrations || []) {
			const record = sanitizePersistedRecord(rawRecord);
			if (!record?.orchestrationId) continue;
			store.upsertPersistedRecord(record, {
				schemaVersion: SCHEMA_VERSION,
				driverRunId: file.driverRunId,
				piSessionId: file.piSessionId,
				status: stale ? "adoption_required" : "read_only",
				readOnly: true,
				adoptionRequired: true,
				loadedAt: Date.now(),
				path: this.statePath,
			});
			loaded += 1;
		}
		return { loaded, path: this.statePath, stale };
	}

	async save(states: OrchestrationRuntimeState[]): Promise<{ path: string; count: number; skipped?: boolean; reason?: string }> {
		const now = Date.now();
		const records = states.filter((state) => !state.persistence?.readOnly).map(persistedRecord);
		if (!records.length && states.some((state) => state.persistence?.readOnly)) return { path: this.statePath, count: 0, skipped: true, reason: "read_only_only" };
		const mode: OrchestrationPersistenceMode = records.some((record) => record.status === "adopted") ? "adopted_current" : "diagnostic";
		const file: OrchestrationPersistedStateFile = { schemaVersion: SCHEMA_VERSION, createdAt: now, updatedAt: now, driverRunId: this.driverRunId, piSessionId: this.piSessionId, mode, privacy: PRIVACY, orchestrations: records };
		await mkdir(path.dirname(this.statePath), { recursive: true });
		const tmp = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
		const handle = await open(tmp, "w", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8" });
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(tmp, this.statePath);
		} catch (error) {
			await unlink(tmp).catch(() => undefined);
			throw error;
		}
		return { path: this.statePath, count: records.length };
	}

	currentMetadata(): { schemaVersion: typeof SCHEMA_VERSION; driverRunId: string; piSessionId: string; path: string } {
		return { schemaVersion: SCHEMA_VERSION, driverRunId: this.driverRunId, piSessionId: this.piSessionId, path: this.statePath };
	}

	static bindingKey(binding: Pick<OrchestrationBinding, "sessionTag" | "tabRole">): string {
		return bindingKey(binding.sessionTag, binding.tabRole);
	}

	static sanitizeBinding(value: unknown): OrchestrationBinding | undefined {
		return sanitizeBinding(value);
	}
}
