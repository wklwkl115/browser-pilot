// hook.js - Pi browser native hook/session commands.

async function injectPiBrowserDispatcherViaCdp(tabId) {
  const code = await (await fetch(chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE))).text();
  const res = await piBrowserEval(tabId, code, true);
  if (!res.ok) return res;
  return { ok: true, data: { method: 'cdp_fallback' } };
}

async function confirmPiBrowserDispatcher(tabId, method) {
  const ping = await callPagePiBrowser(tabId, 'hook.status', {}).catch(e => piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, e.message || String(e), { method }));
  if (ping && (ping.ok || ping.error_code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED || ping.error_code === PI_BROWSER_ERROR_CODES.NO_SESSION)) return { ok: true, data: { method, ping: ping.ok ? 'installed' : 'loaded' } };
  return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'Pi browser dispatcher readiness check failed', { method, ping });
}

async function ensurePiBrowserDispatcher(tabId) {
  const timeoutMs = 3000;
  let scriptingErr;
  try {
    await piWithTimeout(
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PI_BROWSER_HOOK_DISPATCHER_FILE] }),
      timeoutMs,
      'chrome.scripting.executeScript(files)'
    );
    const confirmed = await confirmPiBrowserDispatcher(tabId, 'scripting');
    if (confirmed.ok) return confirmed;
    scriptingErr = new Error(confirmed.message || 'readiness check failed');
  } catch (injectErr) {
    scriptingErr = injectErr;
  }
  try {
    const cdp = await injectPiBrowserDispatcherViaCdp(tabId);
    if (cdp.ok) {
      const confirmed = await confirmPiBrowserDispatcher(tabId, 'cdp_fallback');
      if (confirmed.ok) return { ok: true, data: { ...confirmed.data, fallback_reason: scriptingErr.message } };
      return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'hook.install CDP fallback readiness failed', { scripting: scriptingErr.message, confirm: confirmed });
    }
    return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'hook.install CDP fallback failed', { scripting: scriptingErr.message, cdp: cdp });
  } catch (cdpErr) {
    return piBrowserError(PI_BROWSER_ERROR_CODES.INJECTION_FAILED, 'hook.install injection failed', { scripting: scriptingErr.message, cdp: cdpErr.message });
  }
}

async function handlePiBrowserHookCommand(cmd, tabId, msg) {
  if (cmd === 'hook.list_sessions') return { ok: true, data: { sessions: Array.from(piBrowserSessions.entries()).map(([tid, s]) => ({ tabId: tid, queue: getPiBrowserQueueStats(tid), ...s })), count: piBrowserSessions.size, queues: Array.from(piBrowserTabQueues.entries()).map(([tid]) => ({ tabId: tid, ...getPiBrowserQueueStats(tid) })) } };
  if (cmd === 'hook.install') {
    const injected = await ensurePiBrowserDispatcher(tabId);
    if (!injected.ok) return injected;
    const args = {
      session_id: msg.session_id || msg.sessionId,
      targets: msg.targets,
      options: msg.options,
      buffer_size: msg.buffer_size,
      force: msg.force === true,
      expected_version: msg.expected_version || msg.expectedVersion,
      install_fingerprint: msg.install_fingerprint || msg.installFingerprint
    };
    const res = await callPagePiBrowser(tabId, 'hook.install', args);
    if (res && res.ok) piBrowserSessions.set(tabId, {
      session_id: res.data?.session_id || args.session_id,
      state: res.data?.state || 'INSTALLED',
      installed_at: res.data?.installed_at || new Date().toISOString(),
      targets: msg.targets,
      options: msg.options,
      buffer_size: msg.buffer_size,
      dispatcher_version: res.data?.dispatcher_version || res.data?.pi_browser_version,
      install_epoch: res.data?.install_epoch,
      owner_session_id: res.data?.owner_session_id,
      install_fingerprint: res.data?.install_fingerprint || args.install_fingerprint,
      install_args: args
    });
    return res;
  }
  if (cmd === 'hook.status') {
    const res = await callPagePiBrowserWithAutoReinstall(tabId, 'hook.status', {});
    if (res && res.ok && piBrowserSessions.has(tabId)) piBrowserSessions.set(tabId, { ...piBrowserSessions.get(tabId), state: res.data?.state || piBrowserSessions.get(tabId).state });
    return res;
  }
  if (cmd === 'hook.collect') return await callPagePiBrowserWithAutoReinstall(tabId, 'hook.collect', { since_seq: msg.since_seq, limit: msg.limit, event_types: msg.event_types, timeout_ms: msg.timeout_ms, min_count: msg.min_count });
  if (cmd === 'hook.clear_buffer') return await callPagePiBrowserWithAutoReinstall(tabId, 'hook.clear_buffer', {});
  if (cmd === 'hook.pause') return await callPagePiBrowserWithAutoReinstall(tabId, 'hook.pause', {});
  if (cmd === 'hook.resume') return await callPagePiBrowserWithAutoReinstall(tabId, 'hook.resume', {});
  if (cmd === 'hook.uninstall') {
    let res;
    try {
      cleanupWaitsForUninstall(tabId);
      res = await callPagePiBrowser(tabId, 'hook.uninstall', {});
      return res;
    } finally {
      cleanupPiBrowserTab(tabId, 'hook_uninstall');
    }
  }
  if (cmd === 'hook.evaluate') return await piBrowserEval(tabId, String(msg.expression || ''), msg.awaitPromise !== false);
  if (cmd === 'hook.addEventListener') return await addEventListener(tabId, msg);
  if (cmd === 'hook.removeEventListener') return await removeEventListener(tabId, msg);
  if (cmd === 'hook.getPerformanceEntries') return await getPerformanceEntries(tabId, msg);
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser hook command: ' + cmd, { cmd });
}
