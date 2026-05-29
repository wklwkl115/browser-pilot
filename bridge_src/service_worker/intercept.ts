import { PI_BROWSER_ERROR_CODES, normalizePersistentPiBrowserResponse, piBrowserError, piBrowserPersistentCdp } from "./runtime";
import { subscribePiBrowserCdp, unsubscribePiBrowserCdp } from "./wait_cdp";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse } from "./types";
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
	piBrowserInterceptSessions,
	rememberInterceptDiagnostic,
	rememberInterceptTranscript,
} from "./intercept_model";
import type { InterceptRule, InterceptSession, InterceptTranscriptEntry } from "./intercept_model";

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function interceptCdpSend(tabId: number, method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<JsonRecord> {
	const cdp = piBrowserPersistentCdp();
	if (!cdp?.send) throw new Error("persistent CDP helper is not loaded");
	const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, method, params || {}, { persistent: true, name: "intercept", timeoutMs }));
	const error = asRecord(resp?.error);
	if (!resp || resp.ok === false) throw new Error(String(error.message || resp?.message || resp?.error || `${method} failed`));
	const data = asRecord(resp.data);
	return asRecord(data.result || resp.result || resp.data || {});
}

async function recordInterceptPause(sessionId: string, tabId: number, params: JsonRecord, options: { applyAuto?: boolean; timeoutMs?: unknown } = {}): Promise<PiBridgeResponse> {
	const session = getInterceptSession(tabId, sessionId);
	if (!session) return piBrowserError(PI_BROWSER_ERROR_CODES.SESSION_NOT_FOUND, "intercept session not found", { tabId, sessionId });
	const requestId = String(params.requestId || params.request_id || "").trim();
	if (!requestId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, "intercept.pause requires params.requestId", { tabId, sessionId });
	const matchedRule = matchRule(session, params);
	const entry = { ...params, requestId, matchedRuleId: matchedRule?.ruleId };
	session.paused.set(requestId, entry);
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

async function enableInterceptSession(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const config = normalizeInterceptInstallConfig(msg || {});
	const key = `${Number(tabId)}:${config.sessionId}`;
	let session = piBrowserInterceptSessions.get(key);
	if (!session) {
		session = createInterceptSession(tabId, config);
		piBrowserInterceptSessions.set(key, session);
	} else {
		session.maxTranscript = config.maxTranscript;
	}
	if (session.active) return { ok: true, data: { ...interceptSessionSummary(session), reinstalled: false } };
	try {
		const patterns = session.stages.map((stage) => ({ urlPattern: "*", requestStage: stage === "response" ? "Response" : "Request" }));
		await interceptCdpSend(tabId, "Fetch.enable", { patterns }, msg.timeoutMs ?? msg.timeout_ms);
		const subscriptionId = subscribePiBrowserCdp(tabId, "Fetch.requestPaused", interceptPauseHandler(tabId, session.sessionId));
		if (subscriptionId) session.cdpSubscriptions.push(subscriptionId);
		session.active = true;
		session.installedAt = Date.now();
		rememberInterceptDiagnostic(session, { action: "install", maxTranscript: session.maxTranscript, stages: session.stages, subscriptionId });
		return { ok: true, data: { ...interceptSessionSummary(session), reinstalled: false } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "install_failed", error: errorText(error) });
		return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: config.sessionId });
	}
}

async function disableInterceptSession(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const session = getActiveInterceptSession(tabId, msg);
	if (!session) return piBrowserError(PI_BROWSER_ERROR_CODES.SESSION_NOT_FOUND, "intercept session not found", { cmd: msg.cmd, tabId, sessionId: defaultInterceptSessionId(msg) });
	try {
		if (session.active) await interceptCdpSend(tabId, "Fetch.disable", {}, msg.timeoutMs ?? msg.timeout_ms);
		for (const subscriptionId of session.cdpSubscriptions.splice(0)) unsubscribePiBrowserCdp(subscriptionId);
		session.active = false;
		session.paused.clear();
		rememberInterceptDiagnostic(session, { action: "uninstall" });
		return { ok: true, data: { ...interceptSessionSummary(session), uninstalled: true } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "uninstall_failed", error: errorText(error) });
		return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	}
}

function handleInterceptStatus(tabId: number, msg: PiBridgeCommand): PiBridgeResponse {
	const session = getInterceptSession(tabId, defaultInterceptSessionId(msg));
	if (!session) return { ok: true, data: { tabId, sessionId: defaultInterceptSessionId(msg), active: false, ruleCount: 0, pausedCount: 0, transcriptCount: 0 } };
	return { ok: true, data: interceptSessionSummary(session) };
}

function requireActiveInterceptSession(tabId: number, msg: PiBridgeCommand): { session?: InterceptSession; error?: PiBridgeResponse } {
	const sessionId = defaultInterceptSessionId(msg);
	const session = getInterceptSession(tabId, sessionId);
	if (!session || !session.active) return { error: piBrowserError(PI_BROWSER_ERROR_CODES.SESSION_NOT_FOUND, "intercept session not found", { cmd: msg.cmd, tabId, sessionId }) };
	return { session };
}

function handleInterceptListRules(tabId: number, msg: PiBridgeCommand): PiBridgeResponse {
	const resolved = requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	return { ok: true, data: { tabId, sessionId: session.sessionId, rules: interceptSessionSummary(session)?.rules || [], count: session.rules.length } };
}

function handleInterceptAddRule(tabId: number, msg: PiBridgeCommand): PiBridgeResponse {
	const resolved = requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const rule = normalizeInterceptRule(msg || {});
	session.rules.push(rule);
	rememberInterceptDiagnostic(session, { action: "add_rule", ruleId: rule.ruleId, actionType: rule.action, matcher: rule.matcher });
	return { ok: true, data: { tabId, sessionId: session.sessionId, rule } };
}

function handleInterceptRemoveRule(tabId: number, msg: PiBridgeCommand): PiBridgeResponse {
	const resolved = requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const ruleId = String(msg.ruleId || msg.rule_id || "").trim();
	if (!ruleId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, "intercept.removeRule requires ruleId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	const before = session.rules.length;
	session.rules = session.rules.filter((rule: InterceptRule) => rule.ruleId !== ruleId);
	rememberInterceptDiagnostic(session, { action: "remove_rule", ruleId, removed: before !== session.rules.length });
	return { ok: true, data: { tabId, sessionId: session.sessionId, ruleId, removed: before !== session.rules.length, count: session.rules.length } };
}

async function applyMatchedInterceptRule(tabId: number, sessionId: string, requestId: string, params: JsonRecord, timeoutMs?: unknown): Promise<PiBridgeResponse | null> {
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
		return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: "intercept.auto", tabId, sessionId: session.sessionId, requestId, ruleId: matchedRule.ruleId });
	}
}

function handleInterceptCollect(tabId: number, msg: PiBridgeCommand): PiBridgeResponse {
	const resolved = requireActiveInterceptSession(tabId, msg);
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

async function handleInterceptContinue(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const resolved = requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const requestId = String(msg.requestId || msg.request_id || "").trim();
	if (!requestId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, "intercept.continue requires requestId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	if (!session.paused.has(requestId)) return piBrowserError(PI_BROWSER_ERROR_CODES.REQUEST_NOT_FOUND, "intercept paused request not found", { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	const normalized = normalizeInterceptRequestPatch(msg.patch);
	try {
		await interceptCdpSend(tabId, "Fetch.continueRequest", { requestId, ...normalized.cdpPatch }, msg.timeoutMs ?? msg.timeout_ms);
		session.paused.delete(requestId);
		rememberInterceptTranscript(session, { event: "continue", requestId, action: "continue", diagnostics: normalized.summary });
		return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, continued: true, pausedCount: session.paused.size, mutationSummary: normalized.summary } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "continue_failed", requestId, error: errorText(error) });
		return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	}
}

async function handleInterceptFail(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const resolved = requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const requestId = String(msg.requestId || msg.request_id || "").trim();
	if (!requestId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, "intercept.fail requires requestId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	if (!session.paused.has(requestId)) return piBrowserError(PI_BROWSER_ERROR_CODES.REQUEST_NOT_FOUND, "intercept paused request not found", { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	const errorReason = String(msg.errorReason || msg.error_reason || "Failed");
	try {
		await interceptCdpSend(tabId, "Fetch.failRequest", { requestId, errorReason }, msg.timeoutMs ?? msg.timeout_ms);
		session.paused.delete(requestId);
		rememberInterceptTranscript(session, { event: "fail", requestId, action: "fail", diagnostics: { errorReason } });
		return { ok: true, data: { tabId, sessionId: session.sessionId, requestId, failed: true, errorReason, pausedCount: session.paused.size } };
	} catch (error) {
		rememberInterceptDiagnostic(session, { action: "fail_failed", requestId, error: errorText(error) });
		return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	}
}

async function handleInterceptFulfill(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	const resolved = requireActiveInterceptSession(tabId, msg);
	if (resolved.error) return resolved.error;
	const session = resolved.session!;
	const requestId = String(msg.requestId || msg.request_id || "").trim();
	if (!requestId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, "intercept.fulfill requires requestId", { cmd: msg.cmd, tabId, sessionId: session.sessionId });
	if (!session.paused.has(requestId)) return piBrowserError(PI_BROWSER_ERROR_CODES.REQUEST_NOT_FOUND, "intercept paused request not found", { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
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
		return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, errorText(error), { cmd: msg.cmd, tabId, sessionId: session.sessionId, requestId });
	}
}

export async function handlePiBrowserInterceptCommand(cmd: string, tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
	if (cmd === "intercept.install") return await enableInterceptSession(tabId, msg);
	if (cmd === "intercept.uninstall") return await disableInterceptSession(tabId, msg);
	if (cmd === "intercept.status") return handleInterceptStatus(tabId, msg);
	if (cmd === "intercept.listRules") return handleInterceptListRules(tabId, msg);
	if (cmd === "intercept.addRule") return handleInterceptAddRule(tabId, msg);
	if (cmd === "intercept.removeRule") return handleInterceptRemoveRule(tabId, msg);
	if (cmd === "intercept.collect") return handleInterceptCollect(tabId, msg);
	if (cmd === "intercept.pause") return await recordInterceptPause(defaultInterceptSessionId(msg), tabId, asRecord(msg.params), { applyAuto: msg.autoApply !== false, timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
	if (cmd === "intercept.continue") return await handleInterceptContinue(tabId, msg);
	if (cmd === "intercept.fail") return await handleInterceptFail(tabId, msg);
	if (cmd === "intercept.fulfill") return await handleInterceptFulfill(tabId, msg);
	return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, `Unknown intercept command: ${cmd}`, { cmd, tabId });
}

export function cleanupInterceptSessionTab(tabId: number, reason?: string): JsonRecord {
	let removed = 0;
	for (const [key, session] of Array.from(piBrowserInterceptSessions.entries())) {
		if (Number(session.tabId) !== Number(tabId)) continue;
		removed += 1;
		for (const subscriptionId of session.cdpSubscriptions.splice(0)) unsubscribePiBrowserCdp(subscriptionId);
		rememberInterceptDiagnostic(session, { action: "tab_cleanup", reason: reason || "tab_cleanup" });
		piBrowserInterceptSessions.delete(key);
	}
	return { tabId: Number(tabId), removed, reason: reason || "tab_cleanup" };
}

// ESM module boundary marker for TODO 189
export const __piBridgeModule_intercept = {
	name: "intercept",
	symbols: {
		piBrowserInterceptSessions,
		handlePiBrowserInterceptCommand,
		cleanupInterceptSessionTab,
	},
};
