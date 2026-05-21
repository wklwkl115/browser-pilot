// hook.js - Pi browser native hook/session commands.

import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, PI_BROWSER_HOOK_DISPATCHER_FILE, callPagePiBrowser, callPagePiBrowserWithAutoReinstall, cleanupPiBrowserTab, getPiBrowserQueueStats, piBrowserError, piBrowserEval, piBrowserSessions, piBrowserTabQueues, piWithTimeout } from "./runtime";
import { addEventListener, cleanupPiBrowserPageListenersForTab, getPerformanceEntries, removeEventListener } from "./wait";
import { cleanupWaitsForUninstall } from "./wait_coordinator";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse } from "./types";

async function injectPiBrowserDispatcherViaCdp(tabId: number): Promise<PiBridgeResponse> {
  const code = await (await fetch(chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE))).text();
  const res = await piBrowserEval(tabId, code, true);
  if (!res.ok) return res;
  return { ok: true, data: { method: 'cdp_fallback' } };
}

async function confirmPiBrowserDispatcher(tabId: number, method: string): Promise<PiBridgeResponse> {
  const ping = await callPagePiBrowser(tabId, 'hook.status', {}).catch((e: unknown) => piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, e instanceof Error ? e.message : String(e), { method }));
  if (ping && (ping.ok || ping.error_code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED || ping.error_code === PI_BROWSER_ERROR_CODES.NO_SESSION)) return { ok: true, data: { method, ping: ping.ok ? 'installed' : 'loaded' } };
  return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'Pi browser dispatcher readiness check failed', { method, ping });
}

function piBrowserHookSessionId(msg: PiBridgeCommand | null | undefined): string | null {
  if (!msg) return null;
  const raw = msg.session_id !== undefined ? msg.session_id : msg.sessionId;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
}

function piBrowserHookSessionArgs(msg: PiBridgeCommand): JsonRecord {
  const sessionId = piBrowserHookSessionId(msg);
  return sessionId ? { session_id: sessionId } : {};
}

async function ensurePiBrowserDispatcher(tabId: number): Promise<PiBridgeResponse> {
  const timeoutMs = 3000;
  let scriptingErr: unknown;
  try {
    await piWithTimeout(
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PI_BROWSER_HOOK_DISPATCHER_FILE] }),
      timeoutMs,
      'chrome.scripting.executeScript(files)'
    );
    const confirmed = await confirmPiBrowserDispatcher(tabId, 'scripting');
    if (confirmed.ok) return confirmed;
    scriptingErr = new Error('readiness check failed');
  } catch (injectErr) {
    scriptingErr = injectErr;
  }
  try {
    const cdp = await injectPiBrowserDispatcherViaCdp(tabId);
    if (cdp.ok) {
      const confirmed = await confirmPiBrowserDispatcher(tabId, 'cdp_fallback');
      if (confirmed.ok) return { ok: true, data: { ...((confirmed.data && typeof confirmed.data === 'object') ? confirmed.data as JsonRecord : {}), fallback_reason: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr) } };
      return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'hook.install CDP fallback readiness failed', { scripting: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr), confirm: confirmed });
    }
    return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'hook.install CDP fallback failed', { scripting: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr), cdp: cdp });
  } catch (cdpErr) {
    return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'hook.install injection failed', { scripting: scriptingErr instanceof Error ? scriptingErr.message : String(scriptingErr), cdp: cdpErr instanceof Error ? cdpErr.message : String(cdpErr) });
  }
}

async function handlePiBrowserHookCommand(cmd: string, tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  if (cmd === 'hook.list_sessions') {
    const explicitTab = msg && (msg.tabId !== undefined || msg.targetTabId !== undefined);
    const sessionEntries = Array.from(piBrowserSessions.entries()).filter(([tid]) => !explicitTab || Number(tid) === Number(tabId));
    const queueEntries = Array.from(piBrowserTabQueues.entries()).filter(([tid]) => !explicitTab || Number(tid) === Number(tabId));
    return { ok: true, data: { tabId: explicitTab ? Number(tabId) : undefined, sessions: sessionEntries.map(([tid, s]) => ({ tabId: tid, queue: getPiBrowserQueueStats(tid), ...s })), count: sessionEntries.length, queues: queueEntries.map(([tid]) => ({ tabId: tid, ...getPiBrowserQueueStats(tid) })) } };
  }
  if (cmd === 'hook.install') {
    const injected = await ensurePiBrowserDispatcher(tabId);
    if (!injected.ok) return injected;
    const args = {
      session_id: msg.session_id || msg.sessionId,
      targets: msg.targets,
      options: msg.options,
      buffer_size: msg.buffer_size === undefined ? undefined : Number(msg.buffer_size),
      force: msg.force === true,
      expected_version: msg.expected_version || msg.expectedVersion,
      install_fingerprint: msg.install_fingerprint || msg.installFingerprint
    };
    const res = await callPagePiBrowser(tabId, 'hook.install', args);
    if (res && res.ok) { const data = (res.data && typeof res.data === 'object') ? res.data as JsonRecord : {}; piBrowserSessions.set(tabId, {
      session_id: String(data.session_id || args.session_id || ''),
      state: String(data.state || 'INSTALLED'),
      installed_at: String(data.installed_at || new Date().toISOString()),
      targets: msg.targets,
      options: msg.options,
      buffer_size: msg.buffer_size === undefined ? undefined : Number(msg.buffer_size),
      dispatcher_version: data.dispatcher_version || data.pi_browser_version,
      install_epoch: data.install_epoch,
      owner_session_id: data.owner_session_id,
      install_fingerprint: data.install_fingerprint !== undefined ? String(data.install_fingerprint) : (args.install_fingerprint ? String(args.install_fingerprint) : undefined),
      install_args: args
    }); }
    return res;
  }
  if (cmd === 'hook.status') {
    const res = await callPagePiBrowser(tabId, 'hook.status', piBrowserHookSessionArgs(msg), { timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
    if (res && res.ok && piBrowserSessions.has(tabId)) { const session = piBrowserSessions.get(tabId); const data = (res.data && typeof res.data === 'object') ? res.data as JsonRecord : {}; if (session) piBrowserSessions.set(tabId, { ...session, state: String(data.state || session.state || '') }); }
    return res;
  }
  if (cmd === 'hook.collect') return await callPagePiBrowser(tabId, 'hook.collect', { ...piBrowserHookSessionArgs(msg), since_seq: msg.since_seq, limit: msg.limit, event_types: msg.event_types, timeout_ms: msg.timeout_ms, min_count: msg.min_count }, { timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
  if (cmd === 'hook.clear_buffer') return (await callPagePiBrowserWithAutoReinstall(tabId, 'hook.clear_buffer', piBrowserHookSessionArgs(msg))) || piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'hook.clear_buffer returned no response', { cmd });
  if (cmd === 'hook.pause') return (await callPagePiBrowserWithAutoReinstall(tabId, 'hook.pause', piBrowserHookSessionArgs(msg))) || piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'hook.pause returned no response', { cmd });
  if (cmd === 'hook.resume') return (await callPagePiBrowserWithAutoReinstall(tabId, 'hook.resume', piBrowserHookSessionArgs(msg))) || piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'hook.resume returned no response', { cmd });
  if (cmd === 'hook.uninstall') {
    const requestedSessionId = piBrowserHookSessionId(msg);
    const localSession = piBrowserSessions.get(Number(tabId));
    if (requestedSessionId && localSession?.session_id && String(localSession.session_id) !== requestedSessionId) {
      return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_SESSION, 'hook.uninstall sessionId does not match the installed tab session', { tabId, session_id: requestedSessionId, current_session_id: localSession.session_id });
    }
    const res = await callPagePiBrowser(tabId, 'hook.uninstall', piBrowserHookSessionArgs(msg));
    let listenerCleanup = null;
    const shouldCleanup = res && (res.ok || res.error_code === PI_BROWSER_ERROR_CODES.NO_SESSION || res.error_code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED);
    if (shouldCleanup) {
      try {
        listenerCleanup = typeof cleanupPiBrowserPageListenersForTab === 'function'
          ? await (cleanupPiBrowserPageListenersForTab as (...args: unknown[]) => Promise<PiBridgeResponse>)(tabId, 'hook_uninstall', msg.timeoutMs || msg.timeout_ms || 5000)
          : { ok:true, data:{ tabId:Number(tabId), skipped:true, warning:'page listener cleanup helper unavailable' } };
      } catch (e) {
        listenerCleanup = piBrowserError(PI_BROWSER_ERROR_CODES.EVENT_SUBSCRIPTION_FAILED, 'hook.uninstall page listener cleanup failed', { tabId, reason:e instanceof Error ? e.message : String(e) });
      }
      const hookResponse = /** @type {PiBridgeResponse} */ (res);
      if (hookResponse && typeof hookResponse === 'object') {
        if (hookResponse.ok && hookResponse.data && typeof hookResponse.data === 'object') (hookResponse.data as JsonRecord).listener_cleanup = listenerCleanup?.data || listenerCleanup;
        else if (hookResponse.ok === false) hookResponse.details = { ...(hookResponse.details || {}), listener_cleanup: listenerCleanup?.data || listenerCleanup };
      }
      cleanupWaitsForUninstall(tabId);
      cleanupPiBrowserTab(tabId, 'hook_uninstall');
    }
    return res;
  }
  if (cmd === 'hook.evaluate') return await piBrowserEval(tabId, String(msg.expression || ''), msg.awaitPromise !== false, { timeoutMs: msg.timeoutMs ?? msg.timeout_ms });
  if (cmd === 'hook.addEventListener') return await addEventListener(tabId, msg) as PiBridgeResponse;
  if (cmd === 'hook.removeEventListener') return await removeEventListener(tabId, msg) as PiBridgeResponse;
  if (cmd === 'hook.getPerformanceEntries') return await getPerformanceEntries(tabId, msg) as PiBridgeResponse;
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser hook command: ' + cmd, { cmd });
}
export { injectPiBrowserDispatcherViaCdp, confirmPiBrowserDispatcher, piBrowserHookSessionId, piBrowserHookSessionArgs, ensurePiBrowserDispatcher, handlePiBrowserHookCommand };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_hook = { name: "hook", symbols: { injectPiBrowserDispatcherViaCdp, confirmPiBrowserDispatcher, piBrowserHookSessionId, piBrowserHookSessionArgs, ensurePiBrowserDispatcher, handlePiBrowserHookCommand } };
