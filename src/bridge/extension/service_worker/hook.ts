// hook.js - Browser Pilot hook/session commands.

import { chromeApi as chrome } from "./runtimeEnv";
import { BROWSER_PILOT_ERROR_CODES, BROWSER_PILOT_HOOK_DISPATCHER_FILE, callPageBrowserPilot, cleanupBrowserPilotTab, getBrowserPilotQueueStats, browserPilotError, browserPilotEval, browserPilotSessions, browserPilotTabQueues, browserPilotWithTimeout } from "./runtime";
import { persist as persistState, forget as forgetState, recover as recoverState, registerRecovery, redactConfig } from "./state_store";
import { addEventListener, cleanupBrowserPilotPageListenersForTab, getPerformanceEntries, removeEventListener } from "./wait";
import { collectNodeListenerChain, collectNodeListeners, collectNodeSinkHints } from "./dom_flow";
import { cleanupWaitsForUninstall } from "./wait_coordinator";
import { registerLostHookSessionsGetter } from "./bridge_info";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

const lostHookSessions: Array<{ sessionId: string; tabId: number; config?: unknown; reason: string }> = [];
registerLostHookSessionsGetter(() => lostHookSessions.slice());

async function injectBrowserPilotDispatcherViaCdp(tabId: number): Promise<BrowserPilotBridgeResponse> {
  const code = await (await fetch(chrome.runtime.getURL(BROWSER_PILOT_HOOK_DISPATCHER_FILE))).text();
  const res = await browserPilotEval(tabId, code, true);
  if (!res.ok) return res;
  return { ok: true, data: { method: 'cdp_fallback' } };
}

async function confirmBrowserPilotDispatcher(tabId: number, method: string): Promise<BrowserPilotBridgeResponse> {
  const ping = await callPageBrowserPilot(tabId, 'hook.status', {}).catch((e: unknown) => browserPilotError(BROWSER_PILOT_ERROR_CODES.INJECTION_FAILED, e instanceof Error ? e.message : String(e), { method }));
  if (ping && (ping.ok || ping.error_code === BROWSER_PILOT_ERROR_CODES.NOT_INSTALLED || ping.error_code === BROWSER_PILOT_ERROR_CODES.NO_SESSION)) return { ok: true, data: { method, ping: ping.ok ? 'installed' : 'loaded' } };
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.INJECTION_FAILED, 'Browser Pilot dispatcher readiness check failed', { method, ping });
}

function browserPilotHookSessionId(msg: BrowserPilotBridgeCommand | null | undefined): string | null {
  if (!msg) return null;
  const raw = msg.session_id !== undefined ? msg.session_id : msg.sessionId;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
}

function browserPilotHookSessionArgs(msg: BrowserPilotBridgeCommand): JsonRecord {
  const sessionId = browserPilotHookSessionId(msg);
  return sessionId ? { session_id: sessionId } : {};
}

const BROWSER_PILOT_HOOK_TARGETS: Record<string, { target: string; description: string; eventTypes: string[] }> = {
  console: { target: 'console', description: 'console log/warn/error/info/debug calls', eventTypes: ['console.*'] },
  error: { target: 'error', description: 'window error and unhandledrejection events', eventTypes: ['error.*'] },
  networkApi: { target: 'network', description: 'page fetch/XMLHttpRequest API call evidence, not passive Network recorder replacement', eventTypes: ['network.request', 'network.response', 'network.error'] },
  websocket: { target: 'websocket', description: 'WebSocket constructor, send, message, close, and error events', eventTypes: ['websocket.*'] },
  storage: { target: 'storage', description: 'localStorage/sessionStorage method calls and snapshots', eventTypes: ['storage.*'] },
  crypto: { target: 'crypto', description: 'crypto.getRandomValues and crypto.subtle operation metadata', eventTypes: ['crypto.*'] },
  dom: { target: 'dom', description: 'MutationObserver DOM mutation summaries', eventTypes: ['dom.mutation', 'dom.mutation.overflow', 'dom.mutation.queue_overflow'] },
  domSinks: { target: 'dom_sinks', description: 'innerHTML/outerHTML/insertAdjacentHTML/document.write script text writes', eventTypes: ['dom.sink.*'] },
  cookies: { target: 'cookies', description: 'document.cookie read/write names with redacted values', eventTypes: ['cookies.*'] }
};

const BROWSER_PILOT_HOOK_TARGET_ALIASES: Record<string, string> = {
  console: 'console', logs: 'console', errors: 'error', error: 'error', exceptions: 'error',
  network: 'networkApi', networkapi: 'networkApi', fetch: 'networkApi', xhr: 'networkApi',
  websocket: 'websocket', websockets: 'websocket', ws: 'websocket',
  storage: 'storage', localstorage: 'storage', sessionstorage: 'storage',
  crypto: 'crypto', dom: 'dom', mutations: 'dom', mutation: 'dom',
  domsinks: 'domSinks', dom_sinks: 'domSinks', sinks: 'domSinks',
  cookies: 'cookies', cookie: 'cookies'
};

function normalizeHookTargetName(value: unknown): string | null {
  const normalized = String(value || '').trim().replace(/[_.-]/g, '').toLowerCase();
  return normalized ? BROWSER_PILOT_HOOK_TARGET_ALIASES[normalized] || null : null;
}

function listBrowserPilotHookTargets(): Array<JsonRecord> {
  return Object.entries(BROWSER_PILOT_HOOK_TARGETS).map(([id, spec]) => ({ id, target: spec.target, description: spec.description, eventTypes: spec.eventTypes.slice() }));
}

function expandBrowserPilotHookTargets(input: unknown): { targets: JsonRecord; expanded: Array<JsonRecord>; rejected: string[] } {
  const requested = Array.isArray(input) ? input : (input == null || input === '' ? [] : [input]);
  const ids = requested.length ? requested.map(normalizeHookTargetName).filter((item): item is string => Boolean(item)) : [];
  const rejected = requested.map((item, index) => ({ item, id: normalizeHookTargetName(item), index })).filter((entry) => !entry.id).map((entry) => String(entry.item));
  const unique = Array.from(new Set(ids));
  const targets: JsonRecord = {};
  const expanded: Array<JsonRecord> = [];
  for (const id of unique) {
    const spec = BROWSER_PILOT_HOOK_TARGETS[id];
    if (!spec) continue;
    targets[spec.target] = true;
    expanded.push({ id, target: spec.target, description: spec.description, eventTypes: spec.eventTypes.slice() });
  }
  return { targets, expanded, rejected };
}

function hookInstallArgsFromMessage(msg: BrowserPilotBridgeCommand, targetOverride?: JsonRecord): JsonRecord {
  return {
    session_id: msg.session_id || msg.sessionId,
    targets: targetOverride || msg.targets,
    options: msg.options,
    buffer_size: msg.buffer_size === undefined ? undefined : Number(msg.buffer_size),
    force: msg.force === true,
    expected_version: msg.expected_version || msg.expectedVersion,
    install_fingerprint: msg.install_fingerprint || msg.installFingerprint
  };
}

async function ensureBrowserPilotDispatcher(tabId: number): Promise<BrowserPilotBridgeResponse> {
  const timeoutMs = 3000;
  let scriptingErr: unknown;
  try {
    await browserPilotWithTimeout(
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [BROWSER_PILOT_HOOK_DISPATCHER_FILE] }),
      timeoutMs,
      'chrome.scripting.executeScript(files)'
    );
    const confirmed = await confirmBrowserPilotDispatcher(tabId, 'scripting');
    if (confirmed.ok) return confirmed;
    scriptingErr = new Error('readiness check failed');
  } catch (injectErr) {
    scriptingErr = injectErr;
  }
  try {
    const cdp = await injectBrowserPilotDispatcherViaCdp(tabId);
    if (cdp.ok) {
      const confirmed = await confirmBrowserPilotDispatcher(tabId, 'cdp_fallback');
      if (confirmed.ok) return { ok: true, data: { ...((confirmed.data && typeof confirmed.data === 'object') ? confirmed.data as JsonRecord : {}), fallback_reason: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr) } };
      return browserPilotError(BROWSER_PILOT_ERROR_CODES.INJECTION_FAILED, 'hook.install CDP fallback readiness failed', { scripting: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr), confirm: confirmed });
    }
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INJECTION_FAILED, 'hook.install CDP fallback failed', { scripting: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr), cdp: cdp });
  } catch (cdpErr) {
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INJECTION_FAILED, 'hook.install injection failed', { scripting: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr), cdp: cdpErr instanceof Error ? cdpErr.message : String(cdpErr) });
  }
}

async function handleBrowserPilotHookCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  if (cmd === 'hook.list_sessions') {
    const explicitTab = msg && (msg.tabId !== undefined || msg.targetTabId !== undefined);
    const sessionEntries = Array.from(browserPilotSessions.entries()).filter(([tid]) => !explicitTab || Number(tid) === Number(tabId));
    const queueEntries = Array.from(browserPilotTabQueues.entries()).filter(([tid]) => !explicitTab || Number(tid) === Number(tabId));
    return { ok: true, data: { tabId: explicitTab ? Number(tabId) : undefined, sessions: sessionEntries.map(([tid, s]) => ({ tabId: tid, queue: getBrowserPilotQueueStats(tid), ...s })), count: sessionEntries.length, queues: queueEntries.map(([tid]) => ({ tabId: tid, ...getBrowserPilotQueueStats(tid) })) } };
  }
  if (cmd === 'hook.list_targets') return { ok: true, data: { targets: listBrowserPilotHookTargets(), count: listBrowserPilotHookTargets().length, boundary: 'static-explicit-targets', rejectedStrategyPresets: ['all','auto','aggressive','ctf','exploit','stealth'] } };
  if (cmd === 'hook.install' || cmd === 'hook.install_targets') {
    let expandedTargets: Array<JsonRecord> | undefined;
    let rejectedTargets: string[] | undefined;
    let targetOverride: JsonRecord | undefined;
    if (cmd === 'hook.install_targets') {
      const expanded = expandBrowserPilotHookTargets(msg.targets || msg.hookTargets || msg.targetIds);
      if (expanded.rejected.length) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unsupported hook target ids: ' + expanded.rejected.join(', '), { rejected: expanded.rejected, supported: listBrowserPilotHookTargets().map((item) => item.id) });
      if (!expanded.expanded.length) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'hook.install_targets requires at least one explicit hook target id', { supported: listBrowserPilotHookTargets().map((item) => item.id) });
      expandedTargets = expanded.expanded;
      rejectedTargets = expanded.rejected;
      targetOverride = expanded.targets;
    }
    const injected = await ensureBrowserPilotDispatcher(tabId);
    if (!injected.ok) return injected;
    const args = hookInstallArgsFromMessage(msg, targetOverride);
    const beforeStatus = await callPageBrowserPilot(tabId, 'hook.status', browserPilotHookSessionArgs(msg), { timeoutMs: msg.timeoutMs ?? msg.timeout_ms }).catch(() => null);
    const res = await callPageBrowserPilot(tabId, 'hook.install', args);
    if (res && !res.ok && res.error_code === BROWSER_PILOT_ERROR_CODES.ALREADY_INSTALLED) {
      res.details = {
        ...(res.details || {}),
        recovery: {
          force: true,
          uninstallFirst: true,
          message: 'Hook dispatcher is already installed with a different session or fingerprint; retry with force:true or uninstall the current hook session first.',
        },
      };
    }
    if (res && res.ok) {
      const data = (res.data && typeof res.data === 'object') ? res.data as JsonRecord : {};
      data.reused = data.idempotent === true || data.already_installed === true;
      data.preinstall_status = beforeStatus && beforeStatus.ok ? 'installed' : beforeStatus && beforeStatus.error_code ? String(beforeStatus.error_code) : 'unknown';
      data.history_lost = false;
      if (cmd === 'hook.install_targets') {
        data.expanded_targets = expandedTargets || [];
        data.rejected_targets = rejectedTargets || [];
        data.target_boundary = 'static-explicit-targets';
        data.rejected_strategy_presets = ['all','auto','aggressive','ctf','exploit','stealth'];
      }
      browserPilotSessions.set(tabId, {
      session_id: String(data.session_id || args.session_id || ''),
      state: String(data.state || 'INSTALLED'),
      installed_at: String(data.installed_at || new Date().toISOString()),
      targets: args.targets,
      options: msg.options,
      buffer_size: msg.buffer_size === undefined ? undefined : Number(msg.buffer_size),
      dispatcher_version: data.dispatcher_version || data.browser_pilot_version,
      install_epoch: data.install_epoch,
      owner_session_id: data.owner_session_id,
      install_fingerprint: data.install_fingerprint !== undefined ? String(data.install_fingerprint) : (args.install_fingerprint ? String(args.install_fingerprint) : undefined),
      install_args: args,
      expanded_targets: expandedTargets
    });
    // Persist hook session metadata for state recovery
    const sessionId = String(data.session_id || args.session_id || 'default');
    try { await persistState('hook', `${Number(tabId)}:${sessionId}`, redactConfig({ sessionId, targets: args.targets, options: msg.options, buffer_size: msg.buffer_size }), { tabId, sessionId, recoveryPolicy: 'manual' }); } catch (error) { console.warn('[BROWSER-PILOT-HOOK] Failed to persist hook session state', sessionId, error); }
    }
    return res;
  }
  if (cmd === 'hook.status') {
    const res = await callPageBrowserPilot(tabId, 'hook.status', browserPilotHookSessionArgs(msg), { timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
    if (res && res.ok && browserPilotSessions.has(tabId)) { const session = browserPilotSessions.get(tabId); const data = (res.data && typeof res.data === 'object') ? res.data as JsonRecord : {}; if (session) browserPilotSessions.set(tabId, { ...session, state: String(data.state || session.state || '') }); }
    return res;
  }
  if (cmd === 'hook.collect') return await callPageBrowserPilot(tabId, 'hook.collect', { ...browserPilotHookSessionArgs(msg), since_seq: msg.since_seq, limit: msg.limit, event_types: msg.event_types, timeout_ms: msg.timeout_ms, min_count: msg.min_count }, { timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
  if (cmd === 'hook.clear_buffer') return (await callPageBrowserPilot(tabId, 'hook.clear_buffer', browserPilotHookSessionArgs(msg))) || browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'hook.clear_buffer returned no response', { cmd });
  if (cmd === 'hook.pause') return (await callPageBrowserPilot(tabId, 'hook.pause', browserPilotHookSessionArgs(msg))) || browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'hook.pause returned no response', { cmd });
  if (cmd === 'hook.resume') return (await callPageBrowserPilot(tabId, 'hook.resume', browserPilotHookSessionArgs(msg))) || browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'hook.resume returned no response', { cmd });
  if (cmd === 'hook.uninstall') {
    const requestedSessionId = browserPilotHookSessionId(msg);
    const localSession = browserPilotSessions.get(Number(tabId));
    if (requestedSessionId && localSession?.session_id && String(localSession.session_id) !== requestedSessionId) {
      return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_SESSION, 'hook.uninstall sessionId does not match the installed tab session', { tabId, session_id: requestedSessionId, current_session_id: localSession.session_id });
    }
    const res = await callPageBrowserPilot(tabId, 'hook.uninstall', browserPilotHookSessionArgs(msg));
    const shouldCleanup = res && (res.ok || res.error_code === BROWSER_PILOT_ERROR_CODES.NO_SESSION || res.error_code === BROWSER_PILOT_ERROR_CODES.NOT_INSTALLED);
    if (shouldCleanup) {
      const listenerCleanup: BrowserPilotBridgeResponse | { ok: true; data: { tabId: number; skipped: true; warning: string } } | null = typeof cleanupBrowserPilotPageListenersForTab === 'function'
        ? await (cleanupBrowserPilotPageListenersForTab as (...args: unknown[]) => Promise<BrowserPilotBridgeResponse>)(tabId, 'hook_uninstall', msg.timeoutMs || msg.timeout_ms || 5000).catch((e) => browserPilotError(BROWSER_PILOT_ERROR_CODES.EVENT_SUBSCRIPTION_FAILED, 'hook.uninstall page listener cleanup failed', { tabId, reason:e instanceof Error ? e.message : String(e) }))
        : { ok:true, data:{ tabId:Number(tabId), skipped:true, warning:'page listener cleanup helper unavailable' } };
      const hookResponse = /** @type {BrowserPilotBridgeResponse} */ (res);
      if (hookResponse && typeof hookResponse === 'object') {
        if (hookResponse.ok && hookResponse.data && typeof hookResponse.data === 'object') (hookResponse.data as JsonRecord).listener_cleanup = listenerCleanup?.data || listenerCleanup;
        else if (hookResponse.ok === false) hookResponse.details = { ...(hookResponse.details || {}), listener_cleanup: listenerCleanup?.data || listenerCleanup };
      }
      cleanupWaitsForUninstall(tabId);
      cleanupBrowserPilotTab(tabId, 'hook_uninstall');
      // Forget persisted hook state on uninstall
      const sessionId = localSession?.session_id ? String(localSession.session_id) : 'default';
      try { await forgetState('hook', `${Number(tabId)}:${sessionId}`); } catch (error) { console.warn('[BROWSER-PILOT-HOOK] Failed to forget hook session state', sessionId, error); }
    }
    return res;
  }
  if (cmd === 'hook.evaluate') return await browserPilotEval(tabId, String(msg.expression || ''), msg.awaitPromise !== false, { timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
  if (cmd === 'hook.getNodeListeners') return await collectNodeListeners(tabId, msg);
  if (cmd === 'hook.getListenerChain') return await collectNodeListenerChain(tabId, msg);
  if (cmd === 'hook.getSinkHints') return await collectNodeSinkHints(tabId, msg);
  if (cmd === 'hook.addEventListener') return await addEventListener(tabId, msg) as BrowserPilotBridgeResponse;
  if (cmd === 'hook.removeEventListener') return await removeEventListener(tabId, msg) as BrowserPilotBridgeResponse;
  if (cmd === 'hook.getPerformanceEntries') return await getPerformanceEntries(tabId, msg) as BrowserPilotBridgeResponse;
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown Browser Pilot hook command: ' + cmd, { cmd });
}

// --- Startup recovery registration ---
// Hook recovery is status-only: check if dispatcher still exists on the page.
// If it does, rebuild session metadata. If not, mark as lost. Never auto-reinstall.
registerRecovery(async (results) => {
  const result = await recoverState('hook', {
    validateTab: true,
    recover: async (record) => {
      const tabId = record.tabId;
      if (!tabId) return { recovered: false, historyLost: true, reason: 'missing tabId' };
      const sessionId = record.sessionId || 'default';
      const key = Number(tabId);
      // Don't overwrite existing session
      if (browserPilotSessions.has(key)) return { recovered: false, historyLost: true, reason: 'session already exists' };
      try {
        // Check if dispatcher still exists on the page
        const ping = await callPageBrowserPilot(tabId, 'hook.status', { session_id: sessionId }).catch(() => null);
        if (ping && ping.ok) {
          const data = (ping.data && typeof ping.data === 'object') ? ping.data as JsonRecord : {};
          browserPilotSessions.set(key, {
            session_id: String(data.session_id || sessionId),
            state: String(data.state || 'INSTALLED'),
            installed_at: String(data.installed_at || ''),
            targets: (record.config as JsonRecord)?.targets,
            install_fingerprint: data.install_fingerprint !== undefined ? String(data.install_fingerprint) : undefined,
          });
          return { recovered: true, historyLost: false };
        }
        // Dispatcher not found on page - mark as lost
        return { recovered: false, historyLost: true, reason: 'dispatcher not found on page' };
      } catch (error) {
        return { recovered: false, historyLost: true, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  // Capture lost hook session details so the agent can see which sessions were active before the restart
  for (const entry of result.lost) {
    const parts = entry.key.split(':');
    const tabId = Number(parts[0]) || 0;
    const sessionId = parts.slice(1).join(':') || 'unknown';
    lostHookSessions.push({ sessionId, tabId, config: entry.config, reason: entry.reason || 'unknown' });
  }
  results.push(result);
});

function getLostHookSessions(): Array<{ sessionId: string; tabId: number; config?: unknown; reason: string }> { return lostHookSessions.slice(); }

export { injectBrowserPilotDispatcherViaCdp, confirmBrowserPilotDispatcher, browserPilotHookSessionId, browserPilotHookSessionArgs, ensureBrowserPilotDispatcher, handleBrowserPilotHookCommand, getLostHookSessions };
// ESM module metadata
export const __browserPilotBridgeModule_hook = { name: "hook", symbols: { injectBrowserPilotDispatcherViaCdp, confirmBrowserPilotDispatcher, browserPilotHookSessionId, browserPilotHookSessionArgs, ensureBrowserPilotDispatcher, handleBrowserPilotHookCommand, getLostHookSessions } };
