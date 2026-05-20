// @ts-nocheck
// wait_selector.js - Pi browser selector wait probe and polling helpers.
// Loaded before wait.js by background.js.

const PI_BROWSER_SELECTOR_STABLE_SAMPLES = 2;
const PI_BROWSER_SELECTOR_PROBE_SOURCE = String.raw`(() => {
  const cfg = __PI_BROWSER_SELECTOR_PROBE_CFG__;
  const selector = String(cfg.selector || '');
  const state = String(cfg.state || 'attached');
  const stableMs = Math.max(0, Number(cfg.stableMs || 0));
  const maxStableWaitMs = Math.max(stableMs, Number(cfg.maxStableWaitMs || 10000));
  const mutationEpoch = Number(cfg.mutationEpoch || 0);
  const NOISE_SELECTORS = ['read-frog','.read-frog-translated-content-wrapper','.read-frog-translated-block-content','.read-frog-translated-inline-content','[class*="read-frog-translated"]','#goog-gt-tt','#google_translate_element','.goog-te-banner-frame','.goog-te-balloon-frame','.goog-te-menu-frame','.goog-tooltip','.goog-text-highlight','.skiptranslate','[class^="VIpgJd-"]','[class*=" VIpgJd-"]','#immersive-translate-popup','.immersive-translate-target-wrapper','.immersive-translate-target-translation','[class*="immersive-translate"]','#mate-translate-tooltip','.mate-translate-tooltip','[class*="mate-translate"]','#pi-browser-bridge-ind','#ljq-ind','#__pi_browser_bridge_request__','#aix-drop-panel','#aix-supported-by','[id^="aix-drop-panel"]','[data-testid="floating-button-container"]'];
  const NOISE_ATTR_NAMES = new Set(['data-read-frog-walked','data-read-frog-paragraph','data-read-frog-block-node','data-read-frog-inline-node']);
  const NOISE_ATTR_PREFIXES = ['data-read-frog','data-immersive-translate','data-google-translate','data-mate-translate'];
  const NOISE_CLASS_PATTERNS = ['read-frog-translated','goog-te','goog-tooltip','goog-text-highlight','skiptranslate','VIpgJd-','immersive-translate','mate-translate'];
  function isNoiseAttr(name) {
    const n = String(name || '').toLowerCase();
    return NOISE_ATTR_NAMES.has(n) || NOISE_ATTR_PREFIXES.some(prefix => { const p = String(prefix).toLowerCase(); return n === p || n.startsWith(p + '-'); });
  }
  function isNoiseClass(cls) { return NOISE_CLASS_PATTERNS.some(pattern => String(cls || '').toLowerCase().includes(String(pattern).toLowerCase())); }
  function isNoiseNode(node) { try { return NOISE_SELECTORS.some(sel => node.matches && node.matches(sel)); } catch (_) { return false; } }
  function textWithoutNoise(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (node.nodeType === Node.ELEMENT_NODE && isNoiseNode(node)) return '';
    return Array.from(node.childNodes || []).map(textWithoutNoise).join(' ');
  }
  function cleanupClone(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return root;
    try { root.querySelectorAll(NOISE_SELECTORS.join(',')).forEach(node => node.remove()); } catch (_) {}
    const all = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const node of all) {
      for (const attr of Array.from(node.attributes || [])) {
        if (isNoiseAttr(attr.name)) node.removeAttribute(attr.name);
        else if (attr.name === 'class') {
          const next = String(attr.value || '').split(/\s+/).filter(cls => cls && !isNoiseClass(cls)).join(' ');
          if (next) node.setAttribute('class', next); else node.removeAttribute('class');
        }
      }
    }
    return root;
  }
  function cleanText(value, limit) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
  function sanitizedOuterHtml(node, limit) { return cleanText(cleanupClone(node.cloneNode(true))?.outerHTML || '', limit); }
  let el;
  try { el = document.querySelector(selector); } catch (e) { return {syntaxError:e.message, selector}; }
  const now = performance.now();
  const out = {selector, found:!!el, state, readyState:document.readyState, visibilityState:document.visibilityState, throttled:document.hidden===true, mutationEpoch, maxStableWaitMs};
  if (!el) { out.matched = (state === 'hidden' || state === 'detached'); return out; }
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const viewportW = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const viewportH = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const intersectsViewport = r.bottom > 0 && r.right > 0 && r.top < viewportH && r.left < viewportW;
  const cssVisible = !!(r.width || r.height) && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  const ioStore = (window.__piBrowserSelectorIntersection = window.__piBrowserSelectorIntersection || {});
  const ioKey = selector;
  if (cfg.useIntersectionObserver && cssVisible && !ioStore[ioKey]?.observer && typeof IntersectionObserver === 'function') {
    try {
      const entryState = ioStore[ioKey] = ioStore[ioKey] || {};
      entryState.isIntersecting = intersectsViewport;
      entryState.intersectionRatio = intersectsViewport ? 1 : 0;
      entryState.observer = new IntersectionObserver(entries => {
        const last = entries && entries[entries.length - 1];
        if (last) { entryState.isIntersecting = !!last.isIntersecting; entryState.intersectionRatio = Number(last.intersectionRatio || 0); entryState.ts = performance.now(); }
      }, { threshold: [0, 0.01, 0.5, 1] });
      entryState.observer.observe(el);
    } catch (e) { out.intersectionObserverError = e.message || String(e); }
  }
  const ioState = ioStore[ioKey] || null;
  const rectVisible = cssVisible && intersectsViewport;
  const ioVisible = cfg.visible === true ? !!(ioState ? ioState.isIntersecting : intersectsViewport) : true;
  let hitOk = null;
  let hitTarget = null;
  if (rectVisible && document.elementFromPoint) {
    const samplePoints = [[0.5,0.5],[0.25,0.5],[0.75,0.5],[0.5,0.25],[0.5,0.75]];
    for (const pair of samplePoints) {
      const x = Math.round(Math.max(0, Math.min(viewportW - 1, r.left + r.width * pair[0])));
      const y = Math.round(Math.max(0, Math.min(viewportH - 1, r.top + r.height * pair[1])));
      const hit = document.elementFromPoint(x, y);
      const ok = !hit || hit === el || el.contains(hit) || (hit.contains && hit.contains(el));
      if (!hitTarget && hit) hitTarget = { tagName: hit.tagName ? hit.tagName.toLowerCase() : '', id: hit.id || null, role: hit.getAttribute && hit.getAttribute('role'), text: cleanText(textWithoutNoise(hit), 160) };
      if (ok) { hitOk = true; if (hit) hitTarget = { tagName: hit.tagName ? hit.tagName.toLowerCase() : '', id: hit.id || null, role: hit.getAttribute && hit.getAttribute('role'), text: cleanText(textWithoutNoise(hit), 160) }; break; }
      hitOk = false;
    }
  }
  // Visibility is geometry/CSS based.  IntersectionObserver can lag or report 0
  // for transformed/sticky app layouts, so keep it as diagnostics instead of the
  // decisive visible gate.
  const visible = rectVisible;
  const sig = [Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10,visible].join('|');
  const store = (window.__piBrowserSelectorStable = window.__piBrowserSelectorStable || {});
  const prev = store[selector];
  const resetByMutation = prev && prev.mutationEpoch !== mutationEpoch;
  const stableOrigin = prev && prev.sig === sig && !resetByMutation ? prev.t : now;
  const stableFor = Math.max(0, now - stableOrigin);
  store[selector] = {sig, t:stableOrigin, mutationEpoch};
  const stableTimedOut = stableMs > 0 && stableFor >= maxStableWaitMs;
  const stable = stableMs === 0 || stableFor >= stableMs || stableTimedOut;
  Object.assign(out, {visible, cssVisible, rectVisible, ioVisible, intersectionRatio:ioState ? ioState.intersectionRatio : (intersectsViewport ? 1 : 0), hitOk, hitTarget, attached:true, stableFor, stable, stableTimedOut, text:cleanText(textWithoutNoise(el),500), html:sanitizedOuterHtml(el,2000), rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
  out.matched = (state === 'attached') || (state === 'visible' && visible) || (state === 'hidden' && !visible) || (state === 'stable' && visible && stable) || (state === 'detached' && false);
  return out;
})()`;
function buildSelectorProbe(selector, state, stableMs, options = {}) {
  const cfg = {
    selector: String(selector),
    state: String(state),
    stableMs: Number(stableMs),
    maxStableWaitMs: Number(options.maxStableWaitMs || options.max_stable_wait_ms || 10000),
    mutationEpoch: Number(options.mutationEpoch || 0),
    visible: Boolean(options.visible === true || state === 'visible' || state === 'stable'),
    useIntersectionObserver: options.useIntersectionObserver !== false
  };
  return PI_BROWSER_SELECTOR_PROBE_SOURCE.replace('__PI_BROWSER_SELECTOR_PROBE_CFG__', JSON.stringify(cfg));
}
async function waitForSelector(tabId, msg) {
  const selector = msg.selector || msg.css || msg.target;
  if (!selector) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.selector requires selector', {});
  if (msg.frameId || msg.frame_id) return piBrowserError(PI_BROWSER_ERROR_CODES.CROSS_ORIGIN_IFRAME, 'waitForSelector currently supports the main frame only; frameId is not supported by DOM bridge', { frameId: msg.frameId || msg.frame_id });
  const state = String(msg.state || (msg.visible === true ? 'visible' : 'attached')).toLowerCase(); // attached visible hidden detached stable shadow SELECTOR_TIMEOUT getComputedStyle getBoundingClientRect MutationObserver IntersectionObserver
  if (!['attached','visible','hidden','detached','stable'].includes(state)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'wait.selector unsupported state', { state });
  const timeoutMs = normalizePiBrowserTimeoutMs(msg);
  const pollMs = Math.max(10, Math.min(1000, Number(msg.pollMs || msg.poll_ms || 100)));
  const stableMs = Math.max(50, Math.min(5000, Number(msg.stableMs || msg.stable_ms || 250)));
  const maxStableWaitMs = Math.max(stableMs, Math.min(60000, Math.max(100, Number(msg.maxStableWaitMs || msg.max_stable_wait_ms || 10000))));
  const record = registerWait(tabId, 'selector', { selector: String(selector), state, visible: state === 'visible' || msg.visible === true, timeout_ms: timeoutMs, poll_ms: pollMs, stable_ms: stableMs, max_stable_wait_ms: maxStableWaitMs, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const syntaxCheck = /** @type {any} */ (await piBrowserEval(tabId, `(() => { try { document.querySelector(${JSON.stringify(String(selector))}); return {ok:true}; } catch (e) { return {ok:false,error:e.message}; } })()`, true).catch(e => ({ ok:false, error:e.message || String(e) })));
  const syntaxData = syntaxCheck?.data || syntaxCheck?.result || syntaxCheck;
  if (syntaxData && syntaxData.ok === false) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Invalid selector syntax', { selector:String(selector), syntax_error:syntaxData.error });
  let mutationEpoch = 0;
  const visibleForProbe = msg.visible === true || state === 'visible' || state === 'stable';
  // contract literals: document.querySelector / getBoundingClientRect / visible / IntersectionObserver are inside buildSelectorProbe.
  const evaluate = async () => /** @type {any} */ (await piBrowserEval(tabId, buildSelectorProbe(selector, state, stableMs, { maxStableWaitMs, mutationEpoch, visible: visibleForProbe, useIntersectionObserver: msg.useIntersectionObserver !== false }), true).catch(e => ({ ok:false, error:e.message || String(e), method:'Runtime.evaluate' })));
  const first = await evaluate();
  const firstData = first?.data || first?.result || null;
  if (firstData?.matched) return finishPiBrowserWait(record, true, { element: firstData, state, method: 'Runtime.evaluate', immediate: true });
  if (firstData?.syntaxError) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Invalid selector syntax', { selector:String(selector), syntax_error:firstData.syntaxError });
  if (timeoutMs === 0) return finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.selector immediate check failed', { selector:String(selector), state, timeout_ms:0, snapshot:firstData });
  const deadline = Date.now() + timeoutMs;
  return await new Promise(resolve => {
    let completed = false;
    let timerHandle = null;
    let inFlight = false;
    let pendingTick = false;
    let lastData = firstData || null;
    let lastTickAt = Date.now();
    const clearPollTimer = () => { if (timerHandle) { clearTimeout(timerHandle); const idx = record.timers.indexOf(timerHandle); if (idx >= 0) record.timers.splice(idx, 1); timerHandle = null; } };
    const complete = (res) => { if (completed) return; completed = true; clearPollTimer(); resolve(res); };
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.CANCELLED || 'CANCELLED', waitAbortMessage(record), { selector:String(selector), state })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const triggerTick = (reason, observedEpoch) => {
      if (completed) return;
      const numericEpoch = Number(observedEpoch);
      if (Number.isFinite(numericEpoch)) mutationEpoch = Math.max(mutationEpoch, numericEpoch);
      if (stableMs > 0 && (reason === 'mutation' || reason === 'observer' || reason === 'binding')) mutationEpoch += 1;
      record.last_selector_tick_reason = reason || 'poll';
      clearPollTimer();
      if (inFlight) { pendingTick = true; return; }
      tick(reason || 'trigger');
    };
    const bindingName = '__piBrowserSelectorSignal_' + String(record.waitId || Date.now()).replace(/[^A-Za-z0-9_$]/g, '_');
    const bindingCleanupKey = String(selector) + '|' + state + '|' + bindingName;
    const cdp = piBrowserPersistentCdp();
    const installBindingObserver = async () => {
      if (!cdp?.send) throw new Error('persistent CDP helper is not loaded');
      await enablePiBrowserCdpDomains(record, ['Runtime']);
      const addResp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.addBinding', { name: bindingName }, { persistent: true, name: 'selector_binding', timeoutMs: Math.min(5000, timeoutMs || 5000) }));
      if (!addResp || addResp.ok === false) throw new Error(addResp?.error?.message || addResp?.message || addResp?.error || 'Runtime.addBinding failed');
      const subId = subscribePiBrowserCdp(tabId, 'Runtime.bindingCalled', (_source, _method, params) => {
        if (completed || params?.name !== bindingName) return;
        let payload = {};
        try { payload = JSON.parse(String(params.payload || '{}')); } catch (_) { payload = { raw: params.payload }; }
        const nextEpoch = Number(payload.mutationTick || payload.epoch || 0);
        recordWaitEvent(record, { kind:'selector_binding', reason:payload.reason || 'binding', mutationTick:nextEpoch, payload });
        record.diagnostics.push({ t:Date.now(), reason:'runtime_binding_called', mutationTick:nextEpoch, bindingName });
        triggerTick(payload.reason || 'binding', nextEpoch);
      }, record);
      if (!subId) throw new Error('Runtime.bindingCalled subscription unavailable');
      const installObserver = `(() => {
        const bindingName = ${JSON.stringify(bindingName)};
        const cleanupKey = ${JSON.stringify(bindingCleanupKey)};
        window.__piBrowserSelectorObserverInstalled = window.__piBrowserSelectorObserverInstalled || {};
        window.__piBrowserSelectorMutationTick = window.__piBrowserSelectorMutationTick || 0;
        const notify = (reason, extra) => {
          window.__piBrowserSelectorMutationTick = (window.__piBrowserSelectorMutationTick || 0) + 1;
          const payload = JSON.stringify(Object.assign({reason, mutationTick: window.__piBrowserSelectorMutationTick, readyState: document.readyState, visibilityState: document.visibilityState, ts: Date.now()}, extra || {}));
          try { if (typeof window[bindingName] === 'function') window[bindingName](payload); } catch (e) { (window.__piBrowserSelectorBindingErrors = window.__piBrowserSelectorBindingErrors || []).push(String(e && (e.message || e))); }
          return window.__piBrowserSelectorMutationTick;
        };
        const prior = window.__piBrowserSelectorObserverInstalled[cleanupKey];
        if (prior && prior.observer) { try { prior.observer.disconnect(); } catch (_) {} }
        if (prior && prior.visibilityHandler) { try { document.removeEventListener('visibilitychange', prior.visibilityHandler, true); } catch (_) {} }
        if (prior && prior.readyHandler) { try { document.removeEventListener('DOMContentLoaded', prior.readyHandler, true); } catch (_) {} }
        const stateRef = window.__piBrowserSelectorObserverInstalled[cleanupKey] = {tick: window.__piBrowserSelectorMutationTick, installedAt: Date.now(), bindingName};
        const observer = new MutationObserver((mutations) => {
          stateRef.lastMutationAt = Date.now();
          stateRef.tick = notify('binding', {mutationCount: mutations ? mutations.length : 0});
        });
        observer.observe(document.documentElement || document, {childList:true, subtree:true, attributes:true, characterData:false});
        const visibilityHandler = () => { stateRef.lastVisibilityAt = Date.now(); stateRef.tick = notify('visibilitychange'); };
        const readyHandler = () => { stateRef.lastReadyAt = Date.now(); stateRef.tick = notify('domcontentloaded'); };
        document.addEventListener('visibilitychange', visibilityHandler, true);
        document.addEventListener('DOMContentLoaded', readyHandler, true);
        stateRef.observer = observer;
        stateRef.visibilityHandler = visibilityHandler;
        stateRef.readyHandler = readyHandler;
        stateRef.cleanup = () => {
          try { observer.disconnect(); } catch (_) {}
          try { document.removeEventListener('visibilitychange', visibilityHandler, true); } catch (_) {}
          try { document.removeEventListener('DOMContentLoaded', readyHandler, true); } catch (_) {}
          try { delete window.__piBrowserSelectorObserverInstalled[cleanupKey]; } catch (_) {}
        };
        notify('observer_installed');
        return {ok:true, mutationTick:window.__piBrowserSelectorMutationTick||0, visibilityState:document.visibilityState, bindingName};
      })()`;
      const installed = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression: installObserver, awaitPromise: true, returnByValue: true }, { persistent: true, name: 'selector_binding_install', timeoutMs: Math.min(5000, timeoutMs || 5000) }));
      if (!installed || installed.ok === false) throw new Error(installed?.error?.message || installed?.message || installed?.error || 'selector binding observer install failed');
      const evalData = installed?.data?.result?.result?.value || installed?.data?.result?.value || installed?.result?.result?.value || installed?.result?.value || installed?.data || installed?.result || installed;
      if (Number.isFinite(Number(evalData?.mutationTick))) mutationEpoch = Math.max(mutationEpoch, Number(evalData.mutationTick));
      record.diagnostics.push({ t:Date.now(), reason:'runtime_binding_observer_installed', bindingName, mutationTick:evalData?.mutationTick });
      record.listeners.push({ remove: () => {
        const cleanupExpr = `(() => { const key=${JSON.stringify(bindingCleanupKey)}; const rec=window.__piBrowserSelectorObserverInstalled&&window.__piBrowserSelectorObserverInstalled[key]; if (rec&&typeof rec.cleanup==='function') rec.cleanup(); return true; })()`;
        try { void cdp.send(tabId, 'Runtime.evaluate', { expression: cleanupExpr, awaitPromise: true, returnByValue: true }, { persistent: true, name: 'selector_binding_cleanup', timeoutMs: 1000 }).catch(() => {}); } catch (_) {}
        try { void cdp.send(tabId, 'Runtime.removeBinding', { name: bindingName }, { persistent: true, name: 'selector_binding_remove', timeoutMs: 1000 }).catch(() => {}); } catch (_) {}
      } });
      return true;
    };
    installBindingObserver().catch(e => {
      record.diagnostics.push({ t:Date.now(), warning:'runtime_binding_observer_unavailable_poll_fallback_active', bindingName, error:e.message || String(e) });
    });
    const armPoll = () => {
      if (completed) return;
      clearPollTimer();
      const tickFromPollTimer = () => triggerTick('poll');
      // Compatibility contract for the legacy polling fallback: setTimeout(tick, pollMs)
      timerHandle = setTimeout(tickFromPollTimer, pollMs);
      record.timers.push(timerHandle);
    };
    const tick = async (reason) => {
      if (completed) return;
      if (record.abortController?.signal?.aborted) return failIfAbort();
      if (Date.now() >= deadline) return complete(finishPiBrowserWait(record, false, null, PI_BROWSER_ERROR_CODES.TIMEOUT, 'wait.selector timed out', { selector: String(selector), state, timeout_ms: timeoutMs, diagnostics: record.diagnostics, background_throttling_suspected: Date.now() - lastTickAt > Math.max(2000, pollMs * 5), last_state:lastData }));
      lastTickAt = Date.now();
      inFlight = true;
      const res = await evaluate();
      inFlight = false;
      const data = res?.data || res?.result || null;
      if (data) lastData = data;
      if (data?.matched) return complete(finishPiBrowserWait(record, true, { element: data, state, method: 'Runtime.evaluate', reason: reason || 'poll' }));
      if (data?.throttled) record.diagnostics.push({ t:Date.now(), warning:'background_tab_timer_throttling_possible', visibilityState:data.visibilityState });
      if (data?.stableTimedOut) record.diagnostics.push({ t:Date.now(), warning:'selector_stability_max_wait_reached', stableFor:data.stableFor, maxStableWaitMs:data.maxStableWaitMs });
      if (pendingTick) { pendingTick = false; return triggerTick('pending'); }
      armPoll();
    };
    triggerTick('initial');
  });
}
