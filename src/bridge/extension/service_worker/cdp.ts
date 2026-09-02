import { chromeApi as chrome } from "./runtimeEnv";
import {
	RECOVERY_CODES,
	forget as forgetState,
	get as getState,
	persist as persistState,
	registerRecovery,
	recover as recoverState,
} from "./state_store";
import type {
	JsonRecord,
	BrowserPilotBridgeCommand,
	BrowserPilotBridgeResponse,
	BrowserPilotBridgeSender,
} from "./types";

type CdpResponse = BrowserPilotBridgeResponse<JsonRecord>;
type CdpSession = {
	tabId: number;
	name: string;
	key: string;
	attachedAt: number;
	lastUsed: number;
	commands: number;
	pending: number;
	lockedUntil: number;
	autoDetach: boolean;
	compiledScripts: Map<string, string>;
	scriptCompiles: Map<string, Promise<string | undefined>>;
	scriptHits: Map<string, number>;
	configuredFeatures: Set<string>;
	featurePromises: Map<string, Promise<void>>;
};
type CdpChildSession = {
	tabId: number;
	parentKey: string;
	key: string;
	targetId: string;
	sessionId: string;
	name: string;
	attachedAt: number;
	lastUsed: number;
	commands: number;
	pending: number;
};
type CdpCommandTarget = { debuggee: { tabId: number; sessionId?: string }; route: JsonRecord; child?: CdpChildSession };
type CdpNewDocumentScript = {
	key: string;
	tabId: number;
	identifier: string;
	sessionKey?: unknown;
	cdpSessionName: string;
	method: string;
	createdAt: number;
	runImmediately: boolean;
	includeCommandLineAPI: boolean;
	worldName?: string;
};
type CdpFrame = {
	id: string;
	frameId: string;
	parentId: string | null;
	url: string;
	name: string;
	mimeType: string;
	securityOrigin: string;
	childFrames?: CdpFrame[];
	children?: CdpFrame[];
};
type CdpFrameTreeNode = JsonRecord & { frame?: JsonRecord; childFrames?: CdpFrameTreeNode[] };
type CdpOptions = BrowserPilotBridgeCommand & {
	name?: string;
	protocolVersion?: string;
	bringToFront?: boolean;
	persistent?: boolean;
	detachOnError?: boolean;
	frame?: unknown;
	frameId?: unknown;
	targetId?: unknown;
	sessionId?: unknown;
	worldName?: string;
	grantUniversalAccess?: boolean;
	awaitPromise?: boolean;
	returnByValue?: boolean;
	userGesture?: boolean;
	includeCommandLineAPI?: boolean;
	runImmediately?: boolean;
	precompile?: boolean;
	scriptHash?: string;
	focusEmulation?: boolean;
	requiredDomains?: string[];
	__browserPilotRetryAfterNotAttached?: boolean;
};

function cdpRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function cdpErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function cdpRawError(error: unknown): JsonRecord {
	return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
}

// Persistent CDP sessions and iframe helpers on top of chrome.debugger.
// Flat Target sessions are optional and explicit: the default route remains tab-scoped, while
// callers with a targetId can attach that child target and send through chrome.debugger sessionId.

const PERSISTENT_CDP_VERSION = "p4.1.0";
const PERSISTENT_CDP_DEFAULT_TIMEOUT_MS = 15000;
const PERSISTENT_CDP_MAX_SESSIONS = 16;
const CDP_MAX_COMPILED_SCRIPTS = 32;
const CDP_MAX_SCRIPT_HITS = 64;
const CDP_MAX_NEW_DOCUMENT_SCRIPTS = 32;
const CDP_MAX_NEW_DOCUMENT_SCRIPT_CHARS = 256 * 1024;

const persistentCdpSessions = new Map<string, CdpSession>();
const persistentCdpChildSessions = new Map<string, CdpChildSession>();
const persistentCdpNewDocumentScripts = new Map<string, CdpNewDocumentScript>();
const persistentCdpTabAttaches = new Map<number, Promise<CdpResponse>>();

function persistentCdpHasSessionForTab(tabId: unknown): boolean {
	return Array.from(persistentCdpSessions.values()).some((rec) => Number(rec.tabId) === Number(tabId));
}

function cdpNow(): number {
	return Date.now();
}
function cdpSessionKey(tabId: unknown, name?: unknown): string {
	return String(tabId) + ":" + (name || "default");
}
function cdpTargetSessionKey(tabId: unknown, name: unknown, targetId: unknown): string {
	return cdpSessionKey(tabId, name || "default") + ":target:" + String(targetId || "");
}
function cdpCleanTargetId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}
function cdpCleanSessionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}
function cdpScriptCacheKey(expression: string, params: JsonRecord, options: CdpOptions): string {
	const explicit = typeof options.scriptHash === "string" ? options.scriptHash : "";
	if (explicit) return [explicit, params.contextId ?? "main"].join(":");
	let hash = 2166136261;
	for (let index = 0; index < expression.length; index += 1) {
		hash ^= expression.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return [(hash >>> 0).toString(36), expression.length, params.contextId ?? "main"].join(":");
}
function cdpNewDocumentScriptKey(tabId: unknown, name: unknown, identifier: unknown): string {
	return cdpSessionKey(tabId, name || "new_document") + ":" + String(identifier);
}
function cdpKnownNewDocumentIdentifiers(tabId: unknown, name?: string): string[] {
	return Array.from(persistentCdpNewDocumentScripts.values())
		.filter((rec) => Number(rec.tabId) === Number(tabId) && (!name || rec.cdpSessionName === name))
		.map((rec) => rec.identifier);
}
function cdpStateStoreKey(tabId: unknown, name: unknown, identifier: unknown): string {
	return `new_document:${cdpNewDocumentScriptKey(tabId, name, identifier)}`;
}
async function cdpPersistNewDocumentScript(rec: CdpNewDocumentScript): Promise<void> {
	await persistState(
		"cdp",
		cdpStateStoreKey(rec.tabId, rec.cdpSessionName, rec.identifier),
		{
			tabId: rec.tabId,
			identifier: rec.identifier,
			cdpSessionName: rec.cdpSessionName,
			method: rec.method,
			runImmediately: rec.runImmediately,
			includeCommandLineAPI: rec.includeCommandLineAPI,
			worldName: rec.worldName,
		},
		{
			tabId: rec.tabId,
			sessionId: String(rec.cdpSessionName || "new_document"),
			recoveryPolicy: "diagnosticOnly",
		},
	);
}
async function cdpForgetNewDocumentScriptState(tabId: unknown, name: unknown, identifier: unknown): Promise<void> {
	await forgetState("cdp", cdpStateStoreKey(tabId, name, identifier));
}
async function cdpLostNewDocumentScriptState(tabId: unknown, name: unknown, identifier: unknown): Promise<unknown> {
	const record = await getState("cdp", cdpStateStoreKey(tabId, name, identifier));
	if (!record) return undefined;
	return record.workerBootId !== undefined ? record : undefined;
}
function cdpError(code: string, message: unknown, details: unknown = {}): CdpResponse {
	const safeDetails =
		details && typeof details === "object"
			? (details as JsonRecord)
			: details === undefined
				? {}
				: { raw: details };
	return { ok: false, error: { code, message: String(message || code || "ERROR"), details: safeDetails } };
}
function cdpCommandTargetOk(data: CdpCommandTarget): BrowserPilotBridgeResponse<CdpCommandTarget> {
	return { ok: true, data };
}
function cdpCommandTargetError(resp: CdpResponse): BrowserPilotBridgeResponse<CdpCommandTarget> {
	return resp as BrowserPilotBridgeResponse<CdpCommandTarget>;
}
function cdpAugmentDebuggerEvidence(method: string, data: JsonRecord): JsonRecord {
	const out = { ...data };
	const result = cdpRecord(out.result);
	if (method === "Debugger.enable" && result.debuggerId !== undefined && out.debuggerId === undefined)
		out.debuggerId = result.debuggerId;
	if (method === "Debugger.getScriptSource" && result.scriptSource !== undefined && out.scriptSource === undefined)
		out.scriptSource = result.scriptSource;
	if (method === "Runtime.evaluate") {
		if (result.value !== undefined && out.value === undefined) out.value = result.value;
		if (result.exceptionDetails && out.exceptionDetails === undefined)
			out.exceptionDetails = result.exceptionDetails;
		const exceptionDetails = cdpRecord(out.exceptionDetails);
		if (exceptionDetails.scriptId !== undefined && out.scriptId === undefined)
			out.scriptId = exceptionDetails.scriptId;
		const stackTrace = cdpRecord(exceptionDetails.stackTrace);
		if (Array.isArray(stackTrace.callFrames) && out.callFrames === undefined)
			out.callFrames = stackTrace.callFrames;
	}
	return out;
}
function cdpOk(data: JsonRecord): CdpResponse {
	return { ok: true, data };
}
function cdpWithTimeout<T>(promise: Promise<T>, timeoutMs?: unknown, label = "CDP command"): Promise<T> {
	const ms = Math.max(1, Number(timeoutMs || PERSISTENT_CDP_DEFAULT_TIMEOUT_MS));
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error((label || "CDP command") + " timed out after " + ms + "ms")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cdpFlattenFrameTree(node: CdpFrameTreeNode | null | undefined, out: CdpFrame[] = []): CdpFrame[] {
	if (!node) return out;
	const frame = cdpRecord(node.frame || node);
	if (frame && frame.id)
		out.push({
			id: String(frame.id || ""),
			frameId: String(frame.id || ""),
			parentId: frame.parentId ? String(frame.parentId) : null,
			url: String(frame.url || ""),
			name: String(frame.name || ""),
			mimeType: String(frame.mimeType || ""),
			securityOrigin: String(frame.securityOrigin || ""),
		});
	for (const child of node.childFrames || []) cdpFlattenFrameTree(child, out);
	return out;
}
function cdpNormalizeFrameTreeNode(node: CdpFrameTreeNode | null | undefined): CdpFrame | null {
	if (!node) return null;
	const frame = cdpRecord(node.frame || node);
	const children: CdpFrame[] = [];
	const out: CdpFrame = {
		childFrames: children,
		id: String(frame.id || ""),
		frameId: String(frame.id || ""),
		parentId: frame.parentId ? String(frame.parentId) : null,
		url: String(frame.url || ""),
		name: String(frame.name || ""),
		mimeType: String(frame.mimeType || ""),
		securityOrigin: String(frame.securityOrigin || ""),
		children,
	};
	for (const child of node.childFrames || []) {
		const c = cdpNormalizeFrameTreeNode(child);
		if (c) children.push(c);
	}
	return out;
}

function cdpResolveFrame(frames: CdpFrame[], selector: unknown): CdpFrame | null {
	if (!selector || selector === "main" || selector === "root") return frames[0] || null;
	if (typeof selector === "string") {
		return frames.find((f) => f.frameId === selector || f.name === selector || f.url.includes(selector)) || null;
	}
	const selectorRecord = cdpRecord(selector);
	if (selectorRecord.frameId) return frames.find((f) => f.frameId === selectorRecord.frameId) || null;
	if (selectorRecord.name) return frames.find((f) => f.name === selectorRecord.name) || null;
	if (selectorRecord.urlContains)
		return frames.find((f) => f.url.includes(String(selectorRecord.urlContains))) || null;
	if (selectorRecord.index !== undefined) return frames[Number(selectorRecord.index)] || null;
	return null;
}

async function cdpEnsureSessionCapacity(): Promise<CdpResponse | undefined> {
	if (persistentCdpSessions.size < PERSISTENT_CDP_MAX_SESSIONS) return undefined;
	try {
		await persistentCdpReleaseIdle(0);
	} catch (error) {
		console.warn("[BROWSER-PILOT-CDP] idle release before attach failed", error);
	}
	return persistentCdpSessions.size >= PERSISTENT_CDP_MAX_SESSIONS
		? cdpError("SESSION_LIMIT", "too many persistent CDP sessions", { max: PERSISTENT_CDP_MAX_SESSIONS })
		: undefined;
}

function cdpReuseAttachedSession(tabId: number, name: string, key: string): CdpResponse | undefined {
	const existing =
		persistentCdpSessions.get(cdpSessionKey(tabId, "default")) ??
		Array.from(persistentCdpSessions.values()).find((rec) => rec?.tabId === tabId);
	if (!existing) return undefined;
	existing.lastUsed = cdpNow();
	persistentCdpSessions.set(key, existing);
	return cdpOk({
		sessionKey: key,
		tabId,
		name,
		reused: true,
		attachedAt: existing.attachedAt,
		alreadyAttached: true,
	});
}

async function persistentCdpAttachFresh(
	tabId: number,
	name: string,
	key: string,
	options: CdpOptions,
): Promise<CdpResponse> {
	// Long-running sessions accumulate persistent attachments faster than tab-close
	// cleanup releases them, so evict idle entries before enforcing the hard cap.
	const capacityError = await cdpEnsureSessionCapacity();
	if (capacityError) return capacityError;
	try {
		if (options?.bringToFront) await chrome.tabs.update(tabId, { active: true });
		await chrome.debugger.attach({ tabId }, options?.protocolVersion || "1.3");
		const rec: CdpSession = {
			tabId,
			name,
			key,
			attachedAt: cdpNow(),
			lastUsed: cdpNow(),
			commands: 0,
			pending: 0,
			lockedUntil: 0,
			autoDetach: options?.persistent === false,
			compiledScripts: new Map<string, string>(),
			scriptCompiles: new Map<string, Promise<string | undefined>>(),
			scriptHits: new Map<string, number>(),
			configuredFeatures: new Set<string>(),
			featurePromises: new Map<string, Promise<void>>(),
		};
		persistentCdpSessions.set(key, rec);
		return cdpOk({ sessionKey: key, tabId, name, reused: false, attachedAt: rec.attachedAt });
	} catch (e) {
		const msg = cdpErrorMessage(e);
		if (/Another debugger is already attached|Cannot attach/i.test(String(msg || ""))) {
			const reused = cdpReuseAttachedSession(tabId, String(name), key);
			if (reused) return reused;
		}
		return cdpError("ATTACH_FAILED", msg, { tabId, name, raw: cdpRawError(e) });
	}
}

async function persistentCdpAttach(tabId: number, options: CdpOptions = {}): Promise<CdpResponse> {
	if (!tabId) return cdpError("NO_TAB_ID", "tabId is required");
	const name = String(options?.name || "default");
	const key = cdpSessionKey(tabId, name);
	const existing = persistentCdpSessions.get(key);
	if (existing) {
		existing.lastUsed = cdpNow();
		return cdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt });
	}
	const attaching = persistentCdpTabAttaches.get(tabId);
	if (attaching) {
		const attached = await attaching;
		if (!attached.ok) return attached;
		return (
			cdpReuseAttachedSession(tabId, name, key) ??
			cdpError("ATTACH_FAILED", "CDP session missing after concurrent attach", { tabId, name })
		);
	}
	const pending = persistentCdpAttachFresh(tabId, name, key, options);
	persistentCdpTabAttaches.set(tabId, pending);
	try {
		return await pending;
	} finally {
		if (persistentCdpTabAttaches.get(tabId) === pending) persistentCdpTabAttaches.delete(tabId);
	}
}

async function persistentCdpDetachEntry(key: string): Promise<CdpResponse> {
	const rec = persistentCdpSessions.get(key);
	if (!rec) return cdpOk({ sessionKey: key, detached: false });
	for (const [childKey, child] of Array.from(persistentCdpChildSessions.entries())) {
		if (child.parentKey === key) persistentCdpChildSessions.delete(childKey);
	}
	persistentCdpSessions.delete(key);
	// chrome.debugger attachment is physical per tab, while this bridge exposes
	// logical sessions by name (default/new_document/etc.).  Detaching one
	// logical session must not tear down the tab-wide debugger while another
	// logical session for the same tab still owns CDP state; otherwise Chrome
	// invalidates Page.addScriptToEvaluateOnNewDocument identifiers and a later
	// Page.removeScriptToEvaluateOnNewDocument fails with "Script not found".
	const stillOwned = Array.from(persistentCdpSessions.values()).some(
		(other) => other && Number(other.tabId) === Number(rec.tabId),
	);
	if (stillOwned) {
		return cdpOk({
			sessionKey: key,
			detached: false,
			logicalDetached: true,
			physicalKept: true,
			lifetimeMs: cdpNow() - rec.attachedAt,
			commands: rec.commands,
		});
	}
	try {
		await chrome.debugger.detach({ tabId: rec.tabId });
	} catch (e) {
		return cdpError("DETACH_FAILED", cdpErrorMessage(e), { sessionKey: key, raw: cdpRawError(e) });
	}
	return cdpOk({ sessionKey: key, detached: true, lifetimeMs: cdpNow() - rec.attachedAt, commands: rec.commands });
}

async function persistentCdpDetach(tabId: number, options: CdpOptions = {}): Promise<CdpResponse> {
	const name = options?.name || "default";
	return await persistentCdpDetachEntry(cdpSessionKey(tabId, name));
}

async function persistentCdpAttachTarget(
	tabId: number,
	targetId: unknown,
	options: CdpOptions = {},
): Promise<CdpResponse> {
	const cleanTargetId = cdpCleanTargetId(targetId);
	if (!tabId) return cdpError("NO_TAB_ID", "tabId is required");
	if (!cleanTargetId) return cdpError("NO_TARGET_ID", "targetId is required");
	const name = options?.name || "default";
	const parent = await persistentCdpAttach(tabId, {
		name,
		protocolVersion: options?.protocolVersion,
		bringToFront: options?.bringToFront,
		persistent: true,
	});
	if (!parent.ok) return parent;
	const parentKey = cdpSessionKey(tabId, name);
	const key = cdpTargetSessionKey(tabId, name, cleanTargetId);
	const existing = persistentCdpChildSessions.get(key);
	if (existing) {
		existing.lastUsed = cdpNow();
		return cdpOk({
			sessionKey: parentKey,
			childSessionKey: key,
			tabId,
			targetId: cleanTargetId,
			sessionId: existing.sessionId,
			reused: true,
			attachedAt: existing.attachedAt,
		});
	}
	const existingForTarget = Array.from(persistentCdpChildSessions.values()).find(
		(item) => item.tabId === tabId && item.targetId === cleanTargetId,
	);
	if (existingForTarget) {
		const alias: CdpChildSession = { ...existingForTarget, key, parentKey, name: String(name), lastUsed: cdpNow() };
		persistentCdpChildSessions.set(key, alias);
		return cdpOk({
			sessionKey: parentKey,
			childSessionKey: key,
			tabId,
			targetId: cleanTargetId,
			sessionId: alias.sessionId,
			reused: true,
			aliasOf: existingForTarget.key,
			attachedAt: alias.attachedAt,
		});
	}
	let resolveAttached: (value: { sessionId: string; targetInfo: JsonRecord }) => void = () => {};
	const attached = new Promise<{ sessionId: string; targetInfo: JsonRecord }>((resolve) => {
		resolveAttached = resolve;
	});
	const listener = (
		source: { tabId?: number; targetId?: string; sessionId?: string },
		method: string,
		params?: JsonRecord,
	) => {
		if (Number(source?.tabId) !== Number(tabId) || method !== "Target.attachedToTarget") return;
		const targetInfo = cdpRecord(params?.targetInfo);
		const eventTargetId = cdpCleanTargetId(targetInfo.targetId);
		const sessionId = cdpCleanSessionId(params?.sessionId);
		if (eventTargetId === cleanTargetId && sessionId) resolveAttached({ sessionId, targetInfo });
	};
	try {
		chrome.debugger.onEvent.addListener(listener);
		const params = {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
			filter: [
				{ type: "iframe", exclude: false },
				{ type: "other", exclude: false },
			],
		};
		try {
			await cdpWithTimeout(
				chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", params),
				options?.timeoutMs,
				"Target.setAutoAttach",
			);
		} catch (_setAutoAttachError) {
			await cdpWithTimeout(
				chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
					autoAttach: true,
					waitForDebuggerOnStart: false,
					flatten: true,
				}),
				options?.timeoutMs,
				"Target.setAutoAttach",
			);
		}
		const waitMs = Math.max(500, Math.min(5000, Number(options?.timeoutMs || 5000)));
		const result = await cdpWithTimeout(attached, waitMs, "Target.attachedToTarget");
		const rec: CdpChildSession = {
			tabId,
			parentKey,
			key,
			targetId: cleanTargetId,
			sessionId: result.sessionId,
			name: String(name),
			attachedAt: cdpNow(),
			lastUsed: cdpNow(),
			commands: 0,
			pending: 0,
		};
		persistentCdpChildSessions.set(key, rec);
		return cdpOk({
			sessionKey: parentKey,
			childSessionKey: key,
			tabId,
			targetId: cleanTargetId,
			sessionId: rec.sessionId,
			attachMethod: "Target.setAutoAttach",
			targetInfo: result.targetInfo,
			reused: false,
			attachedAt: rec.attachedAt,
		});
	} catch (e) {
		return cdpError("TARGET_ATTACH_FAILED", cdpErrorMessage(e), {
			tabId,
			targetId: cleanTargetId,
			attachMethod: "Target.setAutoAttach",
			raw: cdpRawError(e),
		});
	} finally {
		chrome.debugger.onEvent.removeListener(listener);
	}
}

async function persistentCdpDetachTarget(
	tabId: number,
	targetIdOrSessionId: unknown,
	options: CdpOptions = {},
): Promise<CdpResponse> {
	const name = options?.name || "default";
	const rawSessionId = cdpCleanSessionId(options?.sessionId);
	const rawTargetId = cdpCleanTargetId(targetIdOrSessionId ?? options?.targetId);
	let child: CdpChildSession | undefined;
	if (rawSessionId)
		child = Array.from(persistentCdpChildSessions.values()).find(
			(item) => item.tabId === tabId && item.sessionId === rawSessionId,
		);
	if (!child && rawTargetId) child = persistentCdpChildSessions.get(cdpTargetSessionKey(tabId, name, rawTargetId));
	if (!child) return cdpOk({ tabId, targetId: rawTargetId, sessionId: rawSessionId, detached: false });
	persistentCdpChildSessions.delete(child.key);
	try {
		await cdpWithTimeout(
			chrome.debugger.sendCommand({ tabId }, "Target.detachFromTarget", { sessionId: child.sessionId }),
			options?.timeoutMs,
			"Target.detachFromTarget",
		);
		return cdpOk({
			tabId,
			targetId: child.targetId,
			sessionId: child.sessionId,
			childSessionKey: child.key,
			detached: true,
			lifetimeMs: cdpNow() - child.attachedAt,
			commands: child.commands,
		});
	} catch (e) {
		return cdpError("TARGET_DETACH_FAILED", cdpErrorMessage(e), {
			tabId,
			targetId: child.targetId,
			sessionId: child.sessionId,
			raw: cdpRawError(e),
		});
	}
}

async function persistentCdpCommandTarget(
	tabId: number,
	name: string,
	rec: CdpSession,
	options: CdpOptions,
): Promise<BrowserPilotBridgeResponse<CdpCommandTarget>> {
	const sessionId = cdpCleanSessionId(options?.sessionId);
	if (sessionId)
		return cdpCommandTargetOk({
			debuggee: { tabId: rec.tabId, sessionId },
			route: { targetScoped: true, attachRouteUsed: false, sessionId },
		});
	const targetId = cdpCleanTargetId(options?.targetId);
	if (!targetId)
		return cdpCommandTargetOk({
			debuggee: { tabId: rec.tabId },
			route: { targetScoped: false, attachRouteUsed: false },
		});
	const attached = await persistentCdpAttachTarget(tabId, targetId, options);
	if (!attached.ok) return cdpCommandTargetError(attached);
	const child = persistentCdpChildSessions.get(cdpTargetSessionKey(tabId, name, targetId));
	const childSessionId = cdpCleanSessionId(cdpRecord(attached.data).sessionId) ?? child?.sessionId;
	if (!childSessionId)
		return cdpCommandTargetError(
			cdpError("TARGET_ATTACH_FAILED", "target session missing after attach", {
				tabId,
				targetId,
				attached: attached.data,
			}),
		);
	return cdpCommandTargetOk({
		debuggee: { tabId: rec.tabId, sessionId: childSessionId },
		route: {
			targetScoped: true,
			attachRouteUsed: true,
			attachMethod: cdpRecord(attached.data).attachMethod || "Target.setAutoAttach",
			targetId,
			sessionId: childSessionId,
			childSessionKey: child?.key,
		},
		child,
	});
}

type CdpSendSession = { name: string; key: string; rec: CdpSession; retrying: boolean };
type CdpSendSessionResult = { ok: true; session: CdpSendSession } | { ok: false; response: CdpResponse };
type CdpPreparedCommand = { data: unknown; precompiled: boolean };

async function cdpAcquireSendSession(tabId: number, options: CdpOptions): Promise<CdpSendSessionResult> {
	const name = options?.name || "default";
	const key = cdpSessionKey(tabId, name);
	let rec = persistentCdpSessions.get(key);
	if (!rec) {
		const attached = await persistentCdpAttach(tabId, {
			name,
			protocolVersion: options?.protocolVersion,
			bringToFront: options?.bringToFront,
			persistent: options?.persistent,
		});
		if (!attached.ok) return { ok: false, response: attached };
		rec = persistentCdpSessions.get(key);
	}
	if (!rec)
		return { ok: false, response: cdpError("ATTACH_FAILED", "CDP session missing after attach", { tabId, name }) };
	// A persistent caller promotes a concurrently-created temporary attachment.
	// Temporary callers never demote an already-owned persistent session.
	if (options?.persistent !== false) rec.autoDetach = false;
	return {
		ok: true,
		session: { name: String(name), key, rec, retrying: Boolean(options?.__browserPilotRetryAfterNotAttached) },
	};
}

function cdpBeginSend(rec: CdpSession, options: CdpOptions): void {
	rec.pending = (rec.pending || 0) + 1;
	rec.lockedUntil = Math.max(rec.lockedUntil || 0, cdpNow() + Number(options?.timeoutMs || 30000));
}

function cdpCompileParams(expression: string, params: JsonRecord, name: string, cacheKey: string): JsonRecord {
	const compileParams: JsonRecord = {
		expression,
		sourceURL: "browser-pilot://" + encodeURIComponent(String(name || "script")) + "/" + cacheKey + ".js",
		persistScript: true,
	};
	if (params.contextId !== undefined) compileParams.executionContextId = params.contextId;
	return compileParams;
}

function cdpRunParams(scriptId: string, params: JsonRecord): JsonRecord {
	const runParams: JsonRecord = {
		scriptId,
		awaitPromise: params.awaitPromise !== false,
		returnByValue: params.returnByValue !== false,
	};
	for (const field of ["objectGroup", "silent", "includeCommandLineAPI", "userGesture"]) {
		if (params[field] !== undefined) runParams[field] = params[field];
	}
	return runParams;
}

async function cdpCompileScript(
	debuggee: CdpCommandTarget["debuggee"],
	expression: string,
	params: JsonRecord,
	options: CdpOptions,
	name: string,
	key: string,
	cacheKey: string,
): Promise<string | undefined> {
	try {
		const compiled = cdpRecord(
			await cdpWithTimeout(
				chrome.debugger.sendCommand(
					debuggee,
					"Runtime.compileScript",
					cdpCompileParams(expression, params, name, cacheKey),
				),
				options?.timeoutMs,
				"Runtime.compileScript",
			),
		);
		return typeof compiled.scriptId === "string" ? compiled.scriptId : undefined;
	} catch (compileError) {
		console.debug(
			"[BROWSER-PILOT-CDP] Runtime.compileScript fallback to evaluate",
			key,
			cdpErrorMessage(compileError),
		);
		return undefined;
	}
}

function cdpTouchBounded<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > maxEntries) {
		const oldest = map.keys().next().value as K | undefined;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

function cdpFeatureKey(debuggee: CdpCommandTarget["debuggee"], feature: string): string {
	return (debuggee.sessionId || "root") + ":" + feature;
}

async function cdpEnsureFeature(
	session: CdpSendSession,
	feature: string,
	configure: () => Promise<unknown>,
): Promise<void> {
	if (session.rec.configuredFeatures.has(feature)) return;
	let pending = session.rec.featurePromises.get(feature);
	if (!pending) {
		pending = (async () => {
			await configure();
			session.rec.configuredFeatures.add(feature);
		})();
		session.rec.featurePromises.set(feature, pending);
	}
	try {
		await pending;
	} finally {
		if (session.rec.featurePromises.get(feature) === pending) session.rec.featurePromises.delete(feature);
	}
}

async function cdpPrepareSessionFeatures(
	session: CdpSendSession,
	debuggee: CdpCommandTarget["debuggee"],
	options: CdpOptions,
): Promise<void> {
	for (const rawDomain of options.requiredDomains || []) {
		const domain = String(rawDomain || "");
		if (!/^[A-Z][A-Za-z0-9]*$/.test(domain)) continue;
		const feature = cdpFeatureKey(debuggee, "domain:" + domain);
		await cdpEnsureFeature(session, feature, () =>
			cdpWithTimeout(
				chrome.debugger.sendCommand(debuggee, domain + ".enable", {}),
				options?.timeoutMs,
				domain + ".enable",
			),
		);
	}
	if (options.focusEmulation !== true) return;
	const focusFeature = cdpFeatureKey(debuggee, "focus-emulation");
	try {
		await cdpEnsureFeature(session, focusFeature, () =>
			cdpWithTimeout(
				chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true }),
				Math.min(2000, Number(options?.timeoutMs || 2000)),
				"Emulation.setFocusEmulationEnabled",
			),
		);
	} catch (error) {
		// Timer-throttle mitigation is best-effort; Runtime.evaluate remains usable on
		// browsers that do not expose Emulation.setFocusEmulationEnabled.
		console.debug("[BROWSER-PILOT-CDP] focus emulation unavailable", session.key, cdpErrorMessage(error));
	}
}

function cdpRecordDomainState(session: CdpSendSession, debuggee: CdpCommandTarget["debuggee"], method: string): void {
	const match = /^([A-Z][A-Za-z0-9]*)\.(enable|disable)$/.exec(method);
	if (!match) return;
	const feature = cdpFeatureKey(debuggee, "domain:" + match[1]);
	if (match[2] === "enable") session.rec.configuredFeatures.add(feature);
	else session.rec.configuredFeatures.delete(feature);
}

async function cdpPrepareCommand(
	method: string,
	params: JsonRecord,
	options: CdpOptions,
	session: CdpSendSession,
	debuggee: CdpCommandTarget["debuggee"],
): Promise<CdpPreparedCommand> {
	const expression = typeof params.expression === "string" ? params.expression : "";
	if (options?.precompile !== true || method !== "Runtime.evaluate" || !expression)
		return { data: undefined, precompiled: false };
	const cacheKey = cdpScriptCacheKey(expression, params, options) + ":" + (debuggee.sessionId || "root");
	let scriptId = session.rec.compiledScripts.get(cacheKey);
	if (scriptId) cdpTouchBounded(session.rec.compiledScripts, cacheKey, scriptId, CDP_MAX_COMPILED_SCRIPTS);
	if (!scriptId) {
		const hits = (session.rec.scriptHits.get(cacheKey) || 0) + 1;
		cdpTouchBounded(session.rec.scriptHits, cacheKey, hits, CDP_MAX_SCRIPT_HITS);
		// One-off scripts are normally temporary. Evaluate them directly on first use;
		// only a second identical request pays compile+run and occupies the persistent
		// V8 script cache. Two calls cost the same total CDP trips as eager compilation,
		// while the common one-shot case saves a trip and leaves no compiled script.
		if (hits < 2) return { data: undefined, precompiled: false };
		let compiling = session.rec.scriptCompiles.get(cacheKey);
		if (!compiling) {
			compiling = cdpCompileScript(debuggee, expression, params, options, session.name, session.key, cacheKey);
			session.rec.scriptCompiles.set(cacheKey, compiling);
		}
		try {
			scriptId = await compiling;
		} finally {
			if (session.rec.scriptCompiles.get(cacheKey) === compiling) session.rec.scriptCompiles.delete(cacheKey);
		}
		if (scriptId) {
			session.rec.scriptHits.delete(cacheKey);
			cdpTouchBounded(session.rec.compiledScripts, cacheKey, scriptId, CDP_MAX_COMPILED_SCRIPTS);
		}
	}
	if (!scriptId) return { data: undefined, precompiled: false };
	try {
		const data = await cdpWithTimeout(
			chrome.debugger.sendCommand(debuggee, "Runtime.runScript", cdpRunParams(scriptId, params)),
			options?.timeoutMs,
			"Runtime.runScript",
		);
		return { data, precompiled: true };
	} catch (runError) {
		const message = cdpErrorMessage(runError);
		if (!/No script with given id/i.test(message)) throw runError;
		session.rec.compiledScripts.delete(cacheKey);
		cdpTouchBounded(session.rec.scriptHits, cacheKey, 1, CDP_MAX_SCRIPT_HITS);
		console.debug(
			"[BROWSER-PILOT-CDP] Runtime.runScript script cache stale; fallback to evaluate",
			session.key,
			message,
		);
		return { data: undefined, precompiled: false };
	}
}

async function cdpExecuteCommand(
	method: string,
	params: JsonRecord,
	options: CdpOptions,
	session: CdpSendSession,
	debuggee: CdpCommandTarget["debuggee"],
): Promise<CdpPreparedCommand> {
	await cdpPrepareSessionFeatures(session, debuggee, options);
	const prepared = await cdpPrepareCommand(method, params, options, session, debuggee);
	if (prepared.data !== undefined) return prepared;
	const data = await cdpWithTimeout(
		chrome.debugger.sendCommand(debuggee, method, params || {}),
		options?.timeoutMs,
		method,
	);
	cdpRecordDomainState(session, debuggee, method);
	return {
		data,
		precompiled: prepared.precompiled,
	};
}

function cdpRecordSend(session: CdpSendSession, child?: CdpChildSession): void {
	session.rec.commands += 1;
	session.rec.lastUsed = cdpNow();
	if (child) {
		child.commands += 1;
		child.lastUsed = cdpNow();
	}
}

function cdpPurgeTabSessions(tabId: number): void {
	persistentCdpTabAttaches.delete(Number(tabId));
	for (const [staleKey, staleRec] of Array.from(persistentCdpSessions.entries())) {
		if (staleRec && Number(staleRec.tabId) === Number(tabId)) persistentCdpSessions.delete(staleKey);
	}
	for (const [staleKey, staleRec] of Array.from(persistentCdpChildSessions.entries())) {
		if (staleRec && Number(staleRec.tabId) === Number(tabId)) persistentCdpChildSessions.delete(staleKey);
	}
}

async function cdpHandleSendError(
	tabId: number,
	method: string,
	params: JsonRecord,
	options: CdpOptions,
	session: CdpSendSession,
	error: unknown,
): Promise<CdpResponse> {
	const message = cdpErrorMessage(error);
	if (
		!session.retrying &&
		/Debugger is not attached|Detached while handling command|Session with given id not found|No session with given id/i.test(
			String(message || ""),
		)
	) {
		cdpPurgeTabSessions(session.rec.tabId);
		return persistentCdpSend(tabId, method, params, {
			...(options || {}),
			__browserPilotRetryAfterNotAttached: true,
		});
	}
	if (options?.detachOnError) await persistentCdpDetach(tabId, { name: session.name });
	return cdpError("SEND_FAILED", message || String(error), {
		sessionKey: session.key,
		method,
		raw: cdpRawError(error),
	});
}

async function cdpFinishSend(session: CdpSendSession, child?: CdpChildSession): Promise<void> {
	session.rec.pending = Math.max(0, (session.rec.pending || 1) - 1);
	if (child) child.pending = Math.max(0, (child.pending || 1) - 1);
	session.rec.lockedUntil = 0;
	session.rec.lastUsed = cdpNow();
	if (session.rec.autoDetach && session.rec.pending === 0) {
		const aliases = Array.from(persistentCdpSessions.entries())
			.filter(([, rec]) => rec === session.rec)
			.map(([key]) => key);
		for (const key of aliases) await persistentCdpDetachEntry(key);
	}
}

async function persistentCdpSend(
	tabId: number,
	method: string,
	params: JsonRecord = {},
	options: CdpOptions = {},
): Promise<CdpResponse> {
	if (!method) return cdpError("NO_METHOD", "CDP method is required");
	const acquired = await cdpAcquireSendSession(tabId, options);
	if (!acquired.ok) return acquired.response;
	const session = acquired.session;
	let child: CdpChildSession | undefined;
	cdpBeginSend(session.rec, options);
	try {
		const routeResp = await persistentCdpCommandTarget(tabId, session.name, session.rec, options);
		if (!routeResp.ok) return routeResp as CdpResponse;
		const routeData = routeResp.data!;
		child = routeData.child;
		if (child) child.pending = (child.pending || 0) + 1;
		const executed = await cdpExecuteCommand(method, params, options, session, routeData.debuggee);
		cdpRecordSend(session, child);
		return cdpOk(
			cdpAugmentDebuggerEvidence(method, {
				result: executed.data,
				sessionKey: session.key,
				method,
				cdpRoute: routeData.route,
				...(executed.precompiled ? { precompiled: true } : {}),
			}),
		);
	} catch (e) {
		return cdpHandleSendError(tabId, method, params, options, session, e);
	} finally {
		await cdpFinishSend(session, child);
	}
}

async function persistentCdpFrameTree(tabId: number, options: CdpOptions = {}): Promise<CdpResponse> {
	// Page.getFrameTree can be incomplete on a fresh debugger attachment until the
	// Page domain is enabled. Request it as an in-session preflight so ordinary CDP
	// calls avoid eager Page/Runtime setup and temporary sessions still attach once.
	const resp = await persistentCdpSend(
		tabId,
		"Page.getFrameTree",
		{},
		{ ...(options || {}), requiredDomains: ["Page"] },
	);
	if (!resp.ok) return resp;
	const rawTree = cdpRecord(cdpRecord(cdpRecord(resp.data).result).frameTree) as CdpFrameTreeNode;
	return cdpOk({ frameTree: cdpNormalizeFrameTreeNode(rawTree), frames: cdpFlattenFrameTree(rawTree, []) });
}

function cdpFrameSelector(options: CdpOptions): unknown {
	return options?.frame || options?.frameId || "main";
}

function cdpIsolatedWorldParams(frame: CdpFrame, options: CdpOptions): JsonRecord {
	return {
		frameId: frame.frameId,
		worldName: options?.worldName || "browser_pilot_" + Math.random().toString(36).slice(2),
		grantUniversalAccess: Boolean(options?.grantUniversalAccess),
	};
}

function cdpFrameEvaluationParams(expression: unknown, executionContextId: unknown, options: CdpOptions): JsonRecord {
	return {
		expression: String(expression || ""),
		contextId: executionContextId,
		awaitPromise: options?.awaitPromise !== false,
		returnByValue: options?.returnByValue !== false,
		userGesture: Boolean(options?.userGesture),
	};
}

function cdpExecutionContextId(response: CdpResponse): unknown {
	return cdpRecord(cdpRecord(response.data).result).executionContextId;
}

async function persistentCdpEvaluateInFrame(
	tabId: number,
	expression: unknown,
	options: CdpOptions = {},
): Promise<CdpResponse> {
	const frameTree = await persistentCdpFrameTree(tabId, options || {});
	if (!frameTree.ok) return frameTree;
	const frameTreeData = cdpRecord(frameTree.data);
	const frames = Array.isArray(frameTreeData.frames) ? (frameTreeData.frames as CdpFrame[]) : [];
	const selector = cdpFrameSelector(options);
	const frame = cdpResolveFrame(frames, selector);
	if (!frame) return cdpError("FRAME_NOT_FOUND", "requested frame not found", { frame: selector, frames });
	try {
		const world = await persistentCdpSend(
			tabId,
			"Page.createIsolatedWorld",
			cdpIsolatedWorldParams(frame, options),
			options || {},
		);
		if (!world.ok) return world;
		const executionContextId = cdpExecutionContextId(world);
		const evalResp = await persistentCdpSend(
			tabId,
			"Runtime.evaluate",
			cdpFrameEvaluationParams(expression, executionContextId, options),
			options || {},
		);
		if (!evalResp.ok) return evalResp;
		return cdpOk({ frame, executionContextId, result: cdpRecord(evalResp.data).result });
	} catch (e) {
		return cdpError("FRAME_EVAL_FAILED", cdpErrorMessage(e), { frame, raw: cdpRawError(e) });
	}
}

function cdpNewDocumentScriptLimitError(tabId: number, name: string, source: string): CdpResponse | undefined {
	if (source.length > CDP_MAX_NEW_DOCUMENT_SCRIPT_CHARS)
		return cdpError("SCRIPT_TOO_LARGE", "new document script source is too large", {
			maxChars: CDP_MAX_NEW_DOCUMENT_SCRIPT_CHARS,
			chars: source.length,
		});
	if (cdpKnownNewDocumentIdentifiers(tabId, name).length >= CDP_MAX_NEW_DOCUMENT_SCRIPTS)
		return cdpError("SCRIPT_LIMIT", "too many new document scripts", {
			tabId: Number(tabId),
			cdpSessionName: name,
			max: CDP_MAX_NEW_DOCUMENT_SCRIPTS,
		});
	return undefined;
}

async function persistentCdpAddNewDocumentScript(
	tabId: number,
	source: unknown,
	options: CdpOptions = {},
): Promise<CdpResponse> {
	if (!source) return cdpError("NO_SOURCE", "script source is required");
	const cdpOptions = {
		...(options || {}),
		persistent: options?.persistent === true,
		name: options?.name || "new_document",
	};
	const scriptSource = String(source);
	const limitError = cdpNewDocumentScriptLimitError(tabId, cdpOptions.name, scriptSource);
	if (limitError) return limitError;
	const params = {
		source: scriptSource,
		includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
		runImmediately: Boolean(options?.runImmediately),
	};
	if (options?.worldName !== undefined) (params as JsonRecord).worldName = String(options.worldName || "");
	const resp = await persistentCdpSend(tabId, "Page.addScriptToEvaluateOnNewDocument", params, cdpOptions);
	if (!resp.ok) return resp;
	const respData = cdpRecord(resp.data);
	const identifier = String(cdpRecord(respData.result).identifier);
	const sessionKey = respData.sessionKey;
	const rec = {
		key: cdpNewDocumentScriptKey(tabId, cdpOptions.name, identifier),
		tabId: Number(tabId),
		identifier,
		sessionKey,
		cdpSessionName: cdpOptions.name,
		method: "Page.addScriptToEvaluateOnNewDocument",
		createdAt: cdpNow(),
		runImmediately: Boolean(options?.runImmediately),
		includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
		worldName: options?.worldName !== undefined ? String(options.worldName || "") : undefined,
	};
	persistentCdpNewDocumentScripts.set(rec.key, rec);
	try {
		await cdpPersistNewDocumentScript(rec);
	} catch (error) {
		console.warn("[BROWSER-PILOT-CDP] Failed to persist new-document script state", rec.key, error);
	}
	return cdpOk({
		identifier,
		sessionKey,
		cdpSessionName: cdpOptions.name,
		tabId: Number(tabId),
		method: rec.method,
		detached: cdpOptions.persistent !== true,
	});
}

async function persistentCdpRemoveNewDocumentScript(
	tabId: number,
	identifier: unknown,
	options: CdpOptions = {},
): Promise<CdpResponse> {
	if (!identifier) return cdpError("NO_IDENTIFIER", "script identifier is required");
	const cdpOptions = {
		...(options || {}),
		persistent: options?.persistent === true,
		name: options?.name || "new_document",
	};
	const id = String(identifier);
	const key = cdpNewDocumentScriptKey(tabId, cdpOptions.name, id);
	const known = persistentCdpNewDocumentScripts.get(key);
	if (!known) {
		const lost = await cdpLostNewDocumentScriptState(tabId, cdpOptions.name, id);
		if (lost) {
			return cdpError(RECOVERY_CODES.LOST, "new document script state was lost after service worker restart", {
				tabId: Number(tabId),
				identifier: id,
				cdpSessionName: String(cdpOptions.name),
				knownIdentifiers: cdpKnownNewDocumentIdentifiers(tabId, String(cdpOptions.name)),
				historyLost: true,
				nextAction: "re-add the new-document script with frame.addNewDocumentScript",
			});
		}
		return cdpError("SCRIPT_NOT_FOUND", "new document script identifier is not registered", {
			tabId: Number(tabId),
			identifier: id,
			cdpSessionName: String(cdpOptions.name),
			knownIdentifiers: cdpKnownNewDocumentIdentifiers(tabId, String(cdpOptions.name)),
		});
	}
	const method = "Page.removeScriptToEvaluateOnNewDocument";
	const resp = await persistentCdpSend(tabId, method, { identifier: id }, cdpOptions);
	if (!resp.ok) {
		const errorRecord = cdpRecord(resp.error);
		const msg = String(errorRecord.message || resp.message || resp.error || "");
		// Chrome may drop a previously registered new-document identifier after a debugger
		// detach or navigation lifecycle reset.  Only known identifiers are treated as
		// idempotent cleanup; arbitrary unknown ids still return SCRIPT_NOT_FOUND above.
		if (
			/(no\s+script|script.*(not\s*found|does\s*not\s*exist|given\s+id)|identifier.*(not\s*found|does\s*not\s*exist))/i.test(
				msg,
			)
		) {
			persistentCdpNewDocumentScripts.delete(key);
			try {
				await cdpForgetNewDocumentScriptState(tabId, cdpOptions.name, id);
			} catch (error) {
				console.warn(
					"[BROWSER-PILOT-CDP] Failed to forget already-removed new-document script state",
					key,
					error,
				);
			}
			return cdpOk({
				identifier: id,
				removed: false,
				alreadyRemoved: true,
				sessionKey: known.sessionKey,
				cdpSessionName: known.cdpSessionName,
				tabId: Number(tabId),
				method,
				error: msg,
			});
		}
		return resp;
	}
	persistentCdpNewDocumentScripts.delete(key);
	try {
		await cdpForgetNewDocumentScriptState(tabId, cdpOptions.name, id);
	} catch (error) {
		console.warn("[BROWSER-PILOT-CDP] Failed to forget new-document script state after removal", key, error);
	}
	return cdpOk({
		identifier: id,
		removed: true,
		alreadyRemoved: false,
		sessionKey: cdpRecord(resp.data).sessionKey || known.sessionKey,
		cdpSessionName: known.cdpSessionName,
		tabId: Number(tabId),
		method,
	});
}

async function persistentCdpReleaseIdle(maxIdleMs?: unknown): Promise<CdpResponse> {
	const now = cdpNow();
	const rawIdleMs = maxIdleMs === undefined || maxIdleMs === null ? 60000 : Number(maxIdleMs);
	const idleMs = Number.isFinite(rawIdleMs) ? rawIdleMs : 60000;
	const released: JsonRecord[] = [];
	const skipped: JsonRecord[] = [];
	for (const [key, rec] of Array.from(persistentCdpSessions.entries())) {
		if (!persistentCdpSessions.has(key)) continue;
		if ((rec.pending || 0) > 0 || (rec.lockedUntil || 0) > now) {
			skipped.push({ sessionKey: key, pending: rec.pending || 0, reason: "idle busy" });
			continue;
		}
		if (now - rec.lastUsed >= idleMs) {
			const res = await persistentCdpDetachEntry(key);
			released.push({ sessionKey: key, ok: res.ok, detached: cdpRecord(res.data).detached === true });
		}
	}
	return cdpOk({ released, skipped, remaining: persistentCdpSessions.size });
}

async function persistentCdpTargets(tabId?: unknown): Promise<CdpResponse> {
	try {
		const allTargets = typeof chrome.debugger.getTargets === "function" ? await chrome.debugger.getTargets() : [];
		const scopedTargets =
			tabId === undefined || tabId === null || tabId === ""
				? allTargets
				: allTargets.filter((target: JsonRecord) => Number(target.tabId) === Number(tabId));
		return cdpOk({
			targets: allTargets,
			scopedTargets,
			count: allTargets.length,
			scopedCount: scopedTargets.length,
			tabId: tabId === undefined ? undefined : Number(tabId),
		});
	} catch (e) {
		return cdpError("SEND_FAILED", cdpErrorMessage(e), { action: "targets", raw: cdpRawError(e) });
	}
}

// Release every persistent CDP session bound to a tab. Invoked from the shared
// tab-teardown path (chrome.tabs.onRemoved / navigation churn) so attachments do
// not leak and fill PERSISTENT_CDP_MAX_SESSIONS over a long session.
// Synchronous by contract: persistentCdpDetachEntry removes each entry from the
// map before its first await, so the map is drained for this tab by the time this
// returns; the physical chrome.debugger.detach completes best-effort afterwards.
function cleanupPersistentCdpForTab(tabId: number, _reason?: string): JsonRecord {
	const target = Number(tabId);
	persistentCdpTabAttaches.delete(target);
	const removed: string[] = [];
	for (const [key, rec] of Array.from(persistentCdpSessions.entries())) {
		if (!rec || Number(rec.tabId) !== target) continue;
		removed.push(key);
		void persistentCdpDetachEntry(key).catch(() => persistentCdpSessions.delete(key));
	}
	for (const [key, rec] of Array.from(persistentCdpChildSessions.entries())) {
		if (rec && Number(rec.tabId) === target) persistentCdpChildSessions.delete(key);
	}
	for (const [key, rec] of Array.from(persistentCdpNewDocumentScripts.entries())) {
		if (rec && Number(rec.tabId) === target) {
			persistentCdpNewDocumentScripts.delete(key);
			void cdpForgetNewDocumentScriptState(rec.tabId, rec.cdpSessionName, rec.identifier).catch(() => {});
		}
	}
	return { tabId: target, released: removed.length, sessionKeys: removed };
}

type CdpActionHandler = (
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	sender: BrowserPilotBridgeSender,
) => Promise<CdpResponse>;

const cdpActionHandlers: Record<string, CdpActionHandler> = {
	attach: (tabId, msg) => persistentCdpAttach(tabId, msg as CdpOptions),
	attachTarget: (tabId, msg) => persistentCdpAttachTarget(tabId, msg.targetId, msg as CdpOptions),
	send: (tabId, msg) =>
		persistentCdpSend(tabId, String(msg.cdpMethod || ""), cdpRecord(msg.params), msg as CdpOptions),
	detachTarget: (tabId, msg) => persistentCdpDetachTarget(tabId, msg.targetId ?? msg.sessionId, msg as CdpOptions),
	detach: (tabId, msg) => persistentCdpDetach(tabId, msg as CdpOptions),
	targets: (_tabId, msg, sender) => persistentCdpTargets(msg.tabId || sender?.tab?.id),
	frameTree: (tabId, msg) => persistentCdpFrameTree(tabId, msg as CdpOptions),
	evaluateInFrame: (tabId, msg) => persistentCdpEvaluateInFrame(tabId, msg.expression, msg as CdpOptions),
	addNewDocumentScript: (tabId, msg) => persistentCdpAddNewDocumentScript(tabId, msg.source, msg as CdpOptions),
	removeNewDocumentScript: (tabId, msg) =>
		persistentCdpRemoveNewDocumentScript(tabId, msg.identifier, msg as CdpOptions),
	releaseIdle: (_tabId, msg) => persistentCdpReleaseIdle(msg.maxIdleMs),
};

async function handlePersistentCdpCommand(
	msg: BrowserPilotBridgeCommand,
	sender: BrowserPilotBridgeSender,
): Promise<CdpResponse> {
	const tabId = Number(msg.tabId || sender?.tab?.id || 0);
	const action = msg.action || msg.method;
	if (!tabId && action !== "releaseIdle") return cdpError("NO_TAB_ID", "tabId is required");
	const handler = typeof action === "string" ? cdpActionHandlers[action] : undefined;
	if (handler) return handler(tabId, msg, sender);
	return cdpError("UNKNOWN_ACTION", "unknown persistent CDP action: " + action, { action });
}

chrome.debugger.onDetach.addListener((source, _reason) => {
	if (!source || !source.tabId) return;
	persistentCdpTabAttaches.delete(Number(source.tabId));
	for (const [key, rec] of Array.from(persistentCdpSessions.entries())) {
		if (rec.tabId === source.tabId) persistentCdpSessions.delete(key);
	}
	for (const [key, rec] of Array.from(persistentCdpChildSessions.entries())) {
		if (rec.tabId === source.tabId) persistentCdpChildSessions.delete(key);
	}
	for (const [key, rec] of Array.from(persistentCdpNewDocumentScripts.entries())) {
		if (rec.tabId === source.tabId) {
			persistentCdpNewDocumentScripts.delete(key);
			void cdpForgetNewDocumentScriptState(rec.tabId, rec.cdpSessionName, rec.identifier).catch(() => {});
		}
	}
});

registerRecovery(async (results) => {
	const result = await recoverState("cdp", {
		validateTab: true,
		recover: async () => ({
			recovered: false,
			historyLost: true,
			reason: "raw new-document script source is not persisted; explicit frame.addNewDocumentScript is required",
		}),
	});
	results.push(result);
});

const browserPilotPersistentCdpBridge = {
	version: PERSISTENT_CDP_VERSION,
	sessions: persistentCdpSessions,
	childSessions: persistentCdpChildSessions,
	newDocumentScripts: persistentCdpNewDocumentScripts,
	attach: persistentCdpAttach,
	attachTarget: persistentCdpAttachTarget,
	send: persistentCdpSend,
	detachTarget: persistentCdpDetachTarget,
	detach: persistentCdpDetach,
	frameTree: persistentCdpFrameTree,
	evaluateInFrame: persistentCdpEvaluateInFrame,
	addNewDocumentScript: persistentCdpAddNewDocumentScript,
	removeNewDocumentScript: persistentCdpRemoveNewDocumentScript,
	releaseIdle: persistentCdpReleaseIdle,
	targets: persistentCdpTargets,
	hasSessionForTab: persistentCdpHasSessionForTab,
	handleCommand: handlePersistentCdpCommand,
};
const cdpGlobal = self as typeof self & {
	BrowserPilotPersistentCdp?: unknown;
	browserPilotPersistentCdpBridge?: unknown;
};
cdpGlobal.BrowserPilotPersistentCdp = browserPilotPersistentCdpBridge;
cdpGlobal.browserPilotPersistentCdpBridge = browserPilotPersistentCdpBridge;
export { persistentCdpSend, cleanupPersistentCdpForTab, handlePersistentCdpCommand, browserPilotPersistentCdpBridge };
