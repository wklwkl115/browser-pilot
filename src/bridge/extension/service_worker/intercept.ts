import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp } from "./runtimeSupport.js";
import { findLostRuntimeSession, persist as persistState, forget as forgetState, recover as recoverState, RECOVERY_CODES, registerRecovery, summarizeLostRuntimeSession } from "./state_store.js";
import { subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp } from "./wait_cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";
import {
	classifyInterceptStage,
	createInterceptSession,
	defaultInterceptSessionId,
	getActiveInterceptSession,
	getInterceptSession,
	interceptRuleMatches,
	interceptSessionSummary,
	normalizeInterceptHeaders,
	normalizeInterceptInstallConfig,
	normalizeInterceptRequestPatch,
	normalizeInterceptRule,
	browserPilotInterceptSessions,
	rememberInterceptDiagnostic,
	rememberInterceptTranscript,
} from "./intercept_model";
import type { InterceptPhase, InterceptRule, InterceptSession, InterceptTranscriptEntry } from "./intercept_model";

const findLostInterceptRuntimeSession = typeof findLostRuntimeSession === "function" ? findLostRuntimeSession : async () => undefined;
const summarizeLostInterceptRuntimeSession = typeof summarizeLostRuntimeSession === "function" ? summarizeLostRuntimeSession : () => undefined;
const INTERCEPT_PAUSED_MAX = 500;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function interceptCdpSend(tabId: number, method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<JsonRecord> {
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send) throw new Error("persistent CDP helper is not loaded");
	const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, method, params || {}, { persistent: true, name: "intercept", timeoutMs }));
	const error = asRecord(resp?.error);
	if (!resp || resp.ok === false) throw new Error(String(error.message || resp?.message || resp?.error || `${method} failed`));
	const data = asRecord(resp.data);
	return asRecord(data.result || resp.result || resp.data || {});
}

async function recordInterceptPause(sessionId: string, tabId: number, params: JsonRecord, options: { applyAuto?: boolean; timeoutMs?: unknown } = {}): Promise<BrowserPilotBridgeResponse> {
	const session = getInterceptSession(tabId, sessionId);
	if (!session) return browserPilotError(BROWSER_PILOT_ERROR_CODES.SESSION_NOT_FOUND, "intercept session not found", { tabId, sessionId });
	const requestId = String(params.requestId || params.request_id || "").trim();
	if (!requestId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "intercept.pause requires params.requestId", { tabId, sessionId });
	const matchedRule = matchRule(session, params);
	const entry = { ...params, requestId, matchedRuleId: matchedRule?.ruleId };
	session.paused.set(requestId, entry);
	void trimPausedRequests(session, tabId);
	rememberInterceptTranscript(session, {
		event: "paused",
		requestId,
		ruleId: matchedRule?.ruleId,
		stage: stageOf(params),
		url: urlOf(params),
		method: methodOf(params),
		resourceType: resourceTypeOf(params),
	});
	if (options.applyAuto !== false && matchedRule) {
		const autoResult = await applyMatchedInterceptRule(tabId, sessionId, requestId, params, options.timeoutMs);
		if (autoResult) return autoResult;
	}
	return { ok: true, data: { tabId, sessionId, requestId, matchedRuleId: matchedRule?.ruleId || null, pausedCount: session.paused.size } };
}

async function trimPausedRequests(session: InterceptSession, tabId: number): Promise<void> {
	while (session.paused.size > INTERCEPT_PAUSED_MAX) {
		const oldestRequestId = session.paused.keys().next().value as string | undefined;
		if (!oldestRequestId) return;
		session.paused.delete(oldestRequestId);
		try {
			await interceptCdpSend(tabId, "Fetch.continueRequest", { requestId: oldestRequestId }, 2_000);
			rememberInterceptTranscript(session, { event: "continue", requestId: oldestRequestId, action: "overflow_continue", diagnostics: { reason: "paused_buffer_overflow", maxPaused: INTERCEPT_PAUSED_MAX } });
		} catch (error) {
			rememberInterceptDiagnostic(session, { action: "paused_overflow_continue_failed", requestId: oldestRequestId, error: errorText(error), maxPaused: INTERCEPT_PAUSED_MAX });
		}
	}
}

function interceptPauseHandler(tabId: number, sessionId: string) {
	return (_source: { tabId?: number }, method: string, params: JsonRecord) => {
		if (method !== "Fetch.requestPaused") return;
		const session = getInterceptSession(tabId, sessionId);
		if (!session || !session.active) return;
		setTimeout(() => {
			const current = getInterceptSession(tabId, sessionId);
			if (!current || !current.active) return;
			void recordInterceptPause(sessionId, tabId, params, { applyAuto: true, timeoutMs: 8_000 }).catch((error) => rememberInterceptDiagnostic(current, { action: "pause_handler_failed", error: errorText(error) }));
		}, 0);
	};
}

async function enableInterceptSession(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const config = normalizeInterceptInstallConfig(msg || {});
	const key = `${Number(tabId)}:${config.sessionId}`;
	let session = browserPilotInterceptSessions.get(key);
	if (!session) {
		session = createInterceptSession(tabId, config);
		browserPilotInterceptSessions.set(key, session);
	} else {
		session.maxTranscript = config.maxTranscript;
	}
	if (session.active) return { ok: true, data: { ...interceptSessionSummary(session), reinstalled: false } };
	try {
		const patterns = session.stages.map((stage) => ({ urlPattern: "*", requestStage: stage === "response" ? "Response" : "Request" }));
		await interceptCdpSend(tabId, "Fetch.enable", { patterns }, msg.timeoutMs ?? msg.timeout_ms);
		const subscriptionId = subscribeBrowserPilotCdp(tabId, "Fetch.requestPaused", interceptPauseHandler(tabId, session.sessionId));
		if (subscriptionId) session.cdpSubscriptions.push(subscriptionId);
		session.active = true;
		session.installedAt = Date.now();
		session.recoveredAt = undefined;
		session.historyLost = false;
		session.pausedLost = false;
		rememberInterceptDiagnostic(session, { action: "install", maxTranscript: session.maxTranscript, stages: session.stages, subscriptionId });
		try {
			const persisted = await persistState('intercept', `${Number(tabId)}:${session.sessionId}`, { stages: session.stages, maxTranscript: session.maxTranscript, rules: session.rules }, { tabId, sessionId: session.sessionId, recoveryPolicy: 'auto' });
			if (persisted.generation !== undefined) session.stateGeneration = Number(persisted.generation);
			if (!persisted.ok && persisted.error) rememberInterceptDiagnostic(session, { action: "persist_failed", error: persisted.error });
		} catch (error) {
			console.warn('[BROWSER-PILOT-INTERCEPT] Failed to persist intercept session state', session.sessionId, error);
		}
		return { ok: true, data: { ...interceptSessionSummary(session), reinstalled: false } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "install_failed", error: errorText(error) });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: config.sessionId });
	}
}

async function disableInterceptSession(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const session = getActiveInterceptSession(tabId, msg);
	if (!session) return browserPilotError(BROWSER_PILOT_ERROR_CODES.SESSION_NOT_FOUND, "intercept session not found", { cmd: msg.cmd, tabId, sessionId: defaultInterceptSessionId(msg) });
	try {
		if (session.active) await interceptCdpSend(tabId, "Fetch.disable", {}, msg.timeoutMs ?? msg.timeout_ms);
		for (const subscriptionId of session.cdpSubscriptions.splice(0)) unsubscribeBrowserPilotCdp(subscriptionId);
		session.active = false;
		session.paused.clear();
		rememberInterceptDiagnostic(session, { action: "uninstall" });
		// Forget persisted state on explicit uninstall
		try { await forgetState('intercept', `${Number(tabId)}:${session.sessionId}`); } catch (error) { console.warn('[BROWSER-PILOT-INTERCEPT] Failed to forget intercept session state', session.sessionId, error); }
		return { ok: true, data: { ...interceptSessionSummary(session), uninstalled: true } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "uninstall_failed", error: errorText(error) });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	}
}

async function handleInterceptStatus(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const sessionId = defaultInterceptSessionId(msg);
	const session = getInterceptSession(tabId, sessionId);
	if (!session) {
		const lost = summarizeLostInterceptRuntimeSession(await findLostInterceptRuntimeSession("intercept", tabId, sessionId));
		return { ok: true, data: { tabId, sessionId, active: false, ruleCount: 0, pausedCount: 0, transcriptCount: 0, stateLost: !!lost, lostSession: lost } };
	}
	return { ok: true, data: interceptSessionSummary(session) };
}

async function requireActiveInterceptSession(tabId: number, msg: BrowserPilotBridgeCommand): Promise<{ session?: InterceptSession; error?: BrowserPilotBridgeResponse }> {
	const sessionId = defaultInterceptSessionId(msg);
	const session = getInterceptSession(tabId, sessionId);
	if (!session || !session.active) return { error: browserPilotError(BROWSER_PILOT_ERROR_CODES.SESSION_NOT_FOUND, "intercept session not found", { cmd: msg.cmd, tabId, sessionId, lostSession: summarizeLostInterceptRuntimeSession(await findLostInterceptRuntimeSession("intercept", tabId, sessionId)) }) };
	return { session };
}

async function handleInterceptListRules(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	return { ok: true, data: { tabId, sessionId: session.sessionId, rules: interceptSessionSummary(session)?.rules || [], count: session.rules.length } };
}

async function handleInterceptAddRule(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const rule = normalizeInterceptRule(msg || {});
	session.rules.push(rule);
	rememberInterceptDiagnostic(session, { action: "add_rule", ruleId: rule.ruleId, actionType: rule.action, matcher: rule.matcher });
	try {
		const persisted = await persistState('intercept', `${Number(tabId)}:${session.sessionId}`, { stages: session.stages, maxTranscript: session.maxTranscript, rules: session.rules }, { tabId, sessionId: session.sessionId, recoveryPolicy: 'auto' });
		if (persisted.generation !== undefined) session.stateGeneration = Number(persisted.generation);
		if (!persisted.ok && persisted.error) rememberInterceptDiagnostic(session, { action: "persist_failed", error: persisted.error });
	} catch (error) {
		console.warn('[BROWSER-PILOT-INTERCEPT] Failed to persist intercept session rules', session.sessionId, error);
	}
	return { ok: true, data: { tabId, sessionId: session.sessionId, rule, generation: session.stateGeneration } };
}

async function handleInterceptRemoveRule(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const ruleId = String(msg.ruleId || msg.rule_id || "").trim();
	if (!ruleId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "intercept.removeRule requires ruleId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	const before = session.rules.length;
	session.rules = session.rules.filter((rule: InterceptRule) => rule.ruleId !== ruleId);
	rememberInterceptDiagnostic(session, { action: "remove_rule", ruleId, removed: before !== session.rules.length });
	try {
		const persisted = await persistState('intercept', `${Number(tabId)}:${session.sessionId}`, { stages: session.stages, maxTranscript: session.maxTranscript, rules: session.rules }, { tabId, sessionId: session.sessionId, recoveryPolicy: 'auto' });
		if (persisted.generation !== undefined) session.stateGeneration = Number(persisted.generation);
		if (!persisted.ok && persisted.error) rememberInterceptDiagnostic(session, { action: "persist_failed", error: persisted.error });
	} catch (error) {
		console.warn('[BROWSER-PILOT-INTERCEPT] Failed to persist intercept session rules after removal', session.sessionId, error);
	}
	return { ok: true, data: { tabId, sessionId: session.sessionId, ruleId, removed: before !== session.rules.length, count: session.rules.length, generation: session.stateGeneration } };
}

async function applyMatchedInterceptRule(tabId: number, sessionId: string, requestId: string, params: JsonRecord, timeoutMs?: unknown): Promise<BrowserPilotBridgeResponse | null> {
	const session = getInterceptSession(tabId, sessionId);
	if (!session) return null;
	const matchedRule = matchRule(session, params);
	if (!matchedRule) return null;
	const patch = asRecord(matchedRule.patch);
	const rawTimeout = timeoutMs ?? patch.timeoutMs ?? patch.timeout_ms;
	const timeout = rawTimeout === undefined || rawTimeout === null ? undefined : Number(rawTimeout);
	try {
		if (matchedRule.action === "continue") {
			const normalized = normalizeInterceptRequestPatch(patch);
			await interceptCdpSend(tabId, "Fetch.continueRequest", { requestId, ...normalized.cdpPatch }, timeout);
			session.paused.delete(requestId);
			rememberInterceptTranscript(session, { event: "continue", requestId, ruleId: matchedRule.ruleId, action: "continue", diagnostics: { ...normalized.summary, autoApplied: true } });
			return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, continued: true, autoApplied: true, mutationSummary: normalized.summary } };
		}
		if (matchedRule.action === "fail") {
			const errorReason = String(patch.errorReason || patch.error_reason || "Failed");
			await interceptCdpSend(tabId, "Fetch.failRequest", { requestId, errorReason }, timeout);
			session.paused.delete(requestId);
			rememberInterceptTranscript(session, { event: "fail", requestId, ruleId: matchedRule.ruleId, action: "fail", diagnostics: { errorReason, autoApplied: true } });
			return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, failed: true, errorReason, autoApplied: true } };
		}
		const isReplaceScript = matchedRule.action === "replaceScript";
		const rawBody = String(patch.body || "");
		const body = patch.bodyBase64 ? String(patch.bodyBase64) : btoa(unescape(encodeURIComponent(rawBody)));
		const responseCode = Number(patch.responseCode ?? patch.response_code ?? params.responseStatusCode ?? 200);
		const responsePhrase = String(patch.responsePhrase || patch.response_phrase || "OK");
		const responseHeaders = normalizeInterceptHeaders(patch.responseHeaders, isReplaceScript ? "application/javascript; charset=utf-8" : undefined);
		await interceptCdpSend(tabId, "Fetch.fulfillRequest", { requestId, responseCode, responsePhrase, responseHeaders, body }, timeout);
		session.paused.delete(requestId);
		rememberInterceptTranscript(session, { event: isReplaceScript ? "replace_script" : "fulfill", requestId, ruleId: matchedRule.ruleId, action: matchedRule.action, status: responseCode, diagnostics: { headerCount: responseHeaders.length, bodyBytes: rawBody.length, autoApplied: true } });
		return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, fulfilled: !isReplaceScript, replacedScript: isReplaceScript, responseCode, autoApplied: true } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "auto_rule_failed", requestId, ruleId: matchedRule.ruleId, error: errorText(error) });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: "intercept.auto", tabId, sessionId: session.sessionId, requestId, ruleId: matchedRule.ruleId });
	}
}

async function handleInterceptCollect(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const afterSeq = Number(msg.afterSeq ?? msg.after_seq ?? 0);
	const limit = Math.max(1, Math.min(500, Math.floor(Number(msg.limit || 50))));
	const events = session.transcript.filter((item: InterceptTranscriptEntry) => Number(item.seq) > afterSeq).slice(0, limit);
	return {
		ok: true,
		data: {
			tabId,
			sessionId: session.sessionId,
			events,
			count: events.length,
			total: session.transcript.length,
			rules: interceptSessionSummary(session)?.rules || [],
			pausedCount: session.paused.size,
			historyLost: session.historyLost === true,
			pausedLost: session.pausedLost === true,
			recoveredAt: session.recoveredAt,
			generation: session.stateGeneration,
			diagnostics: session.diagnostics.slice(-20),
		},
	};
}

function resourceTypeOf(params: JsonRecord): string {
	const resourceType = params.resourceType || params.resource_type || asRecord(params.request).resourceType;
	return resourceType ? String(resourceType) : "";
}

function methodOf(params: JsonRecord): string {
	const request = asRecord(params.request);
	return String(request.method || params.method || "GET").toUpperCase();
}

function urlOf(params: JsonRecord): string {
	const request = asRecord(params.request);
	return String(request.url || params.url || "");
}

function stageOf(params: JsonRecord): "request" | "response" {
	return classifyInterceptStage(params.responseStatusCode !== undefined || params.responseHeaders !== undefined ? "response" : "request");
}

function matchRule(session: ReturnType<typeof getInterceptSession>, params: JsonRecord) {
	if (!session) return undefined;
	const candidate = {
		stage: stageOf(params),
		url: urlOf(params),
		method: methodOf(params),
		resourceType: resourceTypeOf(params),
	};
	return session.rules.find((rule) => interceptRuleMatches(rule, candidate));
}

function interceptPausedRequestMissingError(session: InterceptSession, msg: BrowserPilotBridgeCommand, tabId: number, requestId: string): BrowserPilotBridgeResponse {
	if (session.pausedLost === true || session.historyLost === true) {
		return browserPilotError(RECOVERY_CODES.LOST, "intercept paused request state was lost after service worker restart", {
			cmd: msg.cmd,
			tabId,
			sessionId: session.sessionId,
			requestId,
			pausedLost: true,
			historyLost: session.historyLost === true,
			recoveredAt: session.recoveredAt,
			generation: session.stateGeneration,
			nextAction: "reinstall intercept rules or retry with a new paused request",
		});
	}
	return browserPilotError(BROWSER_PILOT_ERROR_CODES.REQUEST_NOT_FOUND, "intercept paused request not found", { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
}

async function handleInterceptContinue(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const requestId = String(msg.requestId || msg.request_id || "").trim();
	if (!requestId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "intercept.continue requires requestId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	if (!session.paused.has(requestId)) return interceptPausedRequestMissingError(session, msg, tabId, requestId);
	const normalized = normalizeInterceptRequestPatch(msg.patch);
	try {
		await interceptCdpSend(tabId, "Fetch.continueRequest", { requestId, ...normalized.cdpPatch }, msg.timeoutMs ?? msg.timeout_ms);
		session.paused.delete(requestId);
		rememberInterceptTranscript(session, { event: "continue", requestId, action: "continue", diagnostics: normalized.summary });
		return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, continued: true, pausedCount: session.paused.size, mutationSummary: normalized.summary } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "continue_failed", requestId, error: errorText(error) });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	}
}

async function handleInterceptFail(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const requestId = String(msg.requestId || msg.request_id || "").trim();
	if (!requestId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "intercept.fail requires requestId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	if (!session.paused.has(requestId)) return interceptPausedRequestMissingError(session, msg, tabId, requestId);
	const errorReason = String(msg.errorReason || msg.error_reason || "Failed");
	try {
		await interceptCdpSend(tabId, "Fetch.failRequest", { requestId, errorReason }, msg.timeoutMs ?? msg.timeout_ms);
		session.paused.delete(requestId);
		rememberInterceptTranscript(session, { event: "fail", requestId, action: "fail", diagnostics: { errorReason } });
		return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, failed: true, errorReason, pausedCount: session.paused.size } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "fail_failed", requestId, error: errorText(error) });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	}
}

async function handleInterceptFulfill(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const resolved = await requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const requestId = String(msg.requestId || msg.request_id || "").trim();
	if (!requestId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "intercept.fulfill requires requestId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	if (!session.paused.has(requestId)) return interceptPausedRequestMissingError(session, msg, tabId, requestId);
	const responseCode = Number(msg.responseCode ?? msg.response_code ?? 200);
	const responsePhrase = String(msg.responsePhrase || msg.response_phrase || "OK");
	const rawBody = String(msg.body || "");
	const body = msg.bodyBase64 ? String(msg.bodyBase64) : btoa(unescape(encodeURIComponent(rawBody)));
	const responseHeaders = normalizeInterceptHeaders(msg.responseHeaders);
	try {
		await interceptCdpSend(tabId, "Fetch.fulfillRequest", { requestId, responseCode, responsePhrase, responseHeaders, body }, msg.timeoutMs ?? msg.timeout_ms);
		session.paused.delete(requestId);
		rememberInterceptTranscript(session, { event: "fulfill", requestId, action: "fulfill", status: responseCode, diagnostics: { headerCount: responseHeaders.length, bodyBytes: rawBody.length } });
		return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, fulfilled: true, responseCode, pausedCount: session.paused.size } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "fulfill_failed", requestId, error: errorText(error) });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	}
}

export async function handleBrowserPilotInterceptCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	if (cmd === "intercept.install") return await enableInterceptSession(tabId, msg);
	if (cmd === "intercept.uninstall") return await disableInterceptSession(tabId, msg);
	if (cmd === "intercept.status") return await handleInterceptStatus(tabId, msg);
	if (cmd === "intercept.listRules") return await handleInterceptListRules(tabId, msg);
	if (cmd === "intercept.addRule") return await handleInterceptAddRule(tabId, msg);
	if (cmd === "intercept.removeRule") return await handleInterceptRemoveRule(tabId, msg);
	if (cmd === "intercept.collect") return await handleInterceptCollect(tabId, msg);
	if (cmd === "intercept.pause") return await recordInterceptPause(defaultInterceptSessionId(msg), tabId, asRecord(msg.params), { applyAuto: msg.autoApply !== false, timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
	if (cmd === "intercept.continue") return await handleInterceptContinue(tabId, msg);
	if (cmd === "intercept.fail") return await handleInterceptFail(tabId, msg);
	if (cmd === "intercept.fulfill") return await handleInterceptFulfill(tabId, msg);
	return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, `Unknown intercept command: ${cmd}`, { cmd, tabId });
}

export function cleanupInterceptSessionTab(tabId: number, reason?: string): JsonRecord {
	let removed = 0;
	for (const [key, session] of Array.from(browserPilotInterceptSessions.entries())) {
		if (Number(session.tabId) !== Number(tabId)) continue;
		removed += 1;
		for (const subscriptionId of session.cdpSubscriptions.splice(0)) unsubscribeBrowserPilotCdp(subscriptionId);
		rememberInterceptDiagnostic(session, { action: "tab_cleanup", reason: reason || "tab_cleanup" });
		// Forget persisted state on tab cleanup
		void forgetState('intercept', key).catch((error) => console.warn('[BROWSER-PILOT-INTERCEPT] Failed to forget intercept state during tab cleanup', key, error));
		browserPilotInterceptSessions.delete(key);
	}
	return { tabId: Number(tabId), removed, reason: reason || "tab_cleanup" };
}

// --- Startup recovery registration ---
registerRecovery(async (results) => {
	const result = await recoverState('intercept', {
		validateTab: true,
		recover: async (record) => {
			const tabId = record.tabId;
			const config = record.config as { stages?: InterceptPhase[]; maxTranscript?: number; rules?: InterceptRule[] } | undefined;
			if (!tabId || !config) return { recovered: false, historyLost: true, reason: 'missing tabId or config' };
			const sessionId = record.sessionId || 'default';
			const key = `${Number(tabId)}:${sessionId}`;
			// Don't overwrite an existing active session
			if (browserPilotInterceptSessions.has(key)) return { recovered: false, historyLost: true, reason: 'session already exists' };
			try {
				const session = createInterceptSession(tabId, { sessionId, maxTranscript: config.maxTranscript ?? 200, stages: config.stages ?? ['request'] });
				if (config.rules) session.rules = config.rules;
				session.recoveredAt = Date.now();
				session.historyLost = true;
				session.pausedLost = true;
				session.stateGeneration = Number(record.generation || 0);
				browserPilotInterceptSessions.set(key, session);
				const patterns = session.stages.map((stage) => ({ urlPattern: "*", requestStage: stage === "response" ? "Response" : "Request" }));
				try { await interceptCdpSend(tabId, "Fetch.disable", {}); } catch (error) { console.warn('[BROWSER-PILOT-INTERCEPT] Failed to disable Fetch before recovery re-enable', key, error); }
				await interceptCdpSend(tabId, "Fetch.enable", { patterns });
				const subscriptionId = subscribeBrowserPilotCdp(tabId, "Fetch.requestPaused", interceptPauseHandler(tabId, session.sessionId));
				if (subscriptionId) session.cdpSubscriptions.push(subscriptionId);
				session.active = true;
				session.installedAt = Date.now();
				rememberInterceptDiagnostic(session, { action: "recovered", historyLost: true, pausedLost: true, previousWorkerBootId: record.workerBootId, ruleCount: session.rules.length, generation: record.generation });
				return { recovered: true, historyLost: true };
			} catch (error) {
				console.warn('[BROWSER-PILOT-INTERCEPT] Failed to recover intercept session', key, error);
				return { recovered: false, historyLost: true, reason: error instanceof Error ? error.message : String(error) };
			}
		},
	});
	results.push(result);
});

// ESM module metadata
export const __browserPilotBridgeModule_intercept = {
	name: "intercept",
	symbols: {
		browserPilotInterceptSessions,
		handleBrowserPilotInterceptCommand,
		cleanupInterceptSessionTab,
	},
};
