'use strict';

// Pi Browser Bridge popup — shows the live connection state between this extension
// and the local bridge daemon. The authoritative state lives in the offscreen
// document, which answers `browser-pilot-offscreen-status` with the open WS ports;
// the service worker's router ignores that message, so only the offscreen replies.
// No cookies, no clipboard, no tab access — read-only status.

const POLL_MS = 1500;
const QUERY_TIMEOUT_MS = 800;

const el = {
  body: document.body,
  ver: document.getElementById('ver'),
  status: document.getElementById('status'),
  endpoint: document.getElementById('endpoint'),
  meta: document.getElementById('meta'),
  action: document.getElementById('action'),
  // Consent-pending section
  consentSection: document.getElementById('consent-section'),
  consentLabel: document.getElementById('consent-label'),
  consentCode: document.getElementById('consent-code'),
  consentApprove: document.getElementById('consent-approve'),
  consentDeny: document.getElementById('consent-deny'),
  // Agents section
  agentsToggle: document.getElementById('agents-toggle'),
  agentsList: document.getElementById('agents-list'),
  agentsBody: document.getElementById('agents-body'),
};

let pollTimer = null;
let busy = false;
// Track current consent pairing id to debounce repeated approve/deny taps
let pendingConsentId = null;

function setVersion() {
  try {
    const m = chrome.runtime.getManifest();
    el.ver.textContent = (m && m.version) ? ('v' + m.version) : '';
  } catch (_e) { /* manifest unavailable */ }
}

// Ask the offscreen document for its open WS ports. Resolves null on timeout or
// when nothing answers (offscreen not running → daemon offline / SW asleep).
function queryStatus() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish(null), QUERY_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ type: 'browser-pilot-offscreen-status' }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) return finish(null);
        finish(resp || null);
      });
    } catch (_e) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

// Ask the service worker for the current consent state (pending request + paired agents).
// Resolves null on error or when the SW is asleep.
function queryConsent() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish(null), QUERY_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ type: 'browser-pilot-consent-poll' }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) return finish(null);
        finish(resp || null);
      });
    } catch (_e) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

// Send an approve or deny decision for the current pending consent request.
function sendConsentDecide(pairingId, decision) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'browser-pilot-consent-decide', pairingId: pairingId, decision: decision },
        (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        }
      );
    } catch (_e) { resolve(null); }
  });
}

// Revoke an already-paired agent.
function sendConsentRevoke(pairingId) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: 'browser-pilot-consent-revoke', pairingId: pairingId },
        (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        }
      );
    } catch (_e) { resolve(null); }
  });
}

// Nudge the service worker to wake and re-probe the bridge (reuses the existing
// bridge_wake command — no new capability). Best-effort; we re-read status after.
function nudgeWake() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ cmd: 'bridge_wake' }, () => { void chrome.runtime.lastError; resolve(); });
    } catch (_e) { resolve(); }
  });
}

function openPortsOf(resp) {
  const ports = resp && Array.isArray(resp.openPorts) ? resp.openPorts : [];
  return ports.filter((p) => typeof p === 'number');
}

// Show or hide the consent-pending overlay. When a pending consent is present
// the body switches to data-state="consent-pending" so the main status area
// is replaced by the consent card via CSS.
function renderConsent(consentResp) {
  const pending = consentResp && consentResp.pending ? consentResp.pending : null;

  if (pending) {
    pendingConsentId = pending.pairingId;
    el.consentLabel.textContent = pending.label || pending.pairingId;
    el.consentCode.textContent = pending.code || '';
    el.body.dataset.state = 'consent-pending';
    el.consentSection.hidden = false;
  } else {
    pendingConsentId = null;
    el.consentSection.hidden = true;
    // The caller (poll tick) will call render() to restore normal state
  }
}

// Render the paired-agents collapsible list.
function renderAgents(consentResp) {
  const agents = (consentResp && Array.isArray(consentResp.agents)) ? consentResp.agents : [];

  if (agents.length === 0) {
    el.agentsBody.innerHTML = '<div class="agents-empty">暂无</div>';
  } else {
    const rows = agents.map((agent) => {
      const pId = String(agent.pairingId || '');
      const label = String(agent.label || pId);
      const status = String(agent.status || '');
      const leaseHeld = !!agent.leaseHeld;
      const lastSeen = agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleTimeString() : '';

      // Escape text for insertion into innerHTML
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      return (
        '<div class="agent-row" data-pairing-id="' + esc(pId) + '">' +
          '<div class="agent-info">' +
            '<span class="agent-label">' + esc(label) + '</span>' +
            '<span class="agent-status">' + esc(status) +
              (leaseHeld ? ' <span class="lease-badge">持有租约</span>' : '') +
            '</span>' +
            (lastSeen ? '<span class="agent-lastseen">' + esc(lastSeen) + '</span>' : '') +
          '</div>' +
          '<button class="btn btn-sm btn-revoke" data-pairing-id="' + esc(pId) + '">撤销</button>' +
        '</div>'
      );
    });
    el.agentsBody.innerHTML = rows.join('');

    // Attach revoke listeners to freshly created buttons
    el.agentsBody.querySelectorAll('.btn-revoke').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pid = btn.dataset.pairingId;
        if (!pid) return;
        btn.disabled = true;
        await sendConsentRevoke(pid);
        // Re-poll immediately to refresh the list
        await doPoll();
      });
    });
  }

  // Show/hide the agents section wrapper based on whether we have anything useful to show
  el.agentsList.hidden = false;
}

// Combined poll: fetch connection status + consent state, then update UI.
async function doPoll() {
  const [statusResp, consentResp] = await Promise.all([queryStatus(), queryConsent()]);

  const pending = consentResp && consentResp.pending ? consentResp.pending : null;

  if (pending) {
    // Show consent-pending UI; preserve last known connection color underneath
    renderConsent(consentResp);
  } else {
    // No pending consent — restore normal connection state
    el.consentSection.hidden = true;
    pendingConsentId = null;
    render(statusResp);
  }

  // Always update the agents list regardless of pending state
  renderAgents(consentResp);
}

function render(resp) {
  const ports = openPortsOf(resp);
  let state, statusText, endpoint, meta, btn;
  if (resp && ports.length > 0) {
    state = 'connected';
    statusText = '已连接';
    endpoint = '127.0.0.1:' + ports[0];
    meta = ports.length > 1 ? ('桥接已就绪 · ' + ports.length + ' 路连接') : '桥接已就绪 · 实时监测';
    btn = '刷新';
  } else if (resp) {
    state = 'disconnected';
    statusText = '未连接';
    endpoint = '';
    meta = '扩展在线，但暂无到桥接的活动连接';
    btn = '刷新';
  } else {
    state = 'offline';
    statusText = '离线 · 未就绪';
    endpoint = '';
    meta = '守护进程未运行，或 Service Worker 处于休眠';
    btn = '重试连接';
  }
  el.body.dataset.state = state;
  el.status.textContent = statusText;
  if (endpoint) {
    el.endpoint.textContent = endpoint;
    el.endpoint.classList.remove('hidden');
  } else {
    el.endpoint.classList.add('hidden');
  }
  el.meta.textContent = meta;
  el.action.textContent = btn;
  el.action.dataset.mode = state === 'offline' ? 'retry' : 'refresh';
}

async function refresh() {
  if (busy) return;
  await doPoll();
}

async function onAction() {
  if (busy) return;
  busy = true;
  el.action.disabled = true;
  try {
    if (el.action.dataset.mode === 'retry') {
      el.body.dataset.state = 'connecting';
      el.status.textContent = '连接中…';
      el.meta.textContent = '正在唤醒并重连桥接';
      el.endpoint.classList.add('hidden');
      await nudgeWake();
      // Give the SW a moment to re-create the offscreen doc and probe the port.
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const resp = await queryStatus();
        if (openPortsOf(resp).length > 0) { render(resp); return; }
      }
      render(await queryStatus());
    } else {
      await doPoll();
    }
  } finally {
    busy = false;
    el.action.disabled = false;
  }
}

async function onConsentApprove() {
  if (!pendingConsentId) return;
  el.consentApprove.disabled = true;
  el.consentDeny.disabled = true;
  const pid = pendingConsentId;
  await sendConsentDecide(pid, 'approve');
  await doPoll();
  el.consentApprove.disabled = false;
  el.consentDeny.disabled = false;
}

async function onConsentDeny() {
  if (!pendingConsentId) return;
  el.consentApprove.disabled = true;
  el.consentDeny.disabled = true;
  const pid = pendingConsentId;
  await sendConsentDecide(pid, 'deny');
  await doPoll();
  el.consentApprove.disabled = false;
  el.consentDeny.disabled = false;
}

function onAgentsToggle() {
  const isOpen = el.agentsList.dataset.open === 'true';
  el.agentsList.dataset.open = isOpen ? 'false' : 'true';
  el.agentsToggle.dataset.open = isOpen ? 'false' : 'true';
}

function start() {
  setVersion();
  el.action.addEventListener('click', onAction);
  el.consentApprove.addEventListener('click', onConsentApprove);
  el.consentDeny.addEventListener('click', onConsentDeny);
  el.agentsToggle.addEventListener('click', onAgentsToggle);
  void refresh();
  pollTimer = setInterval(() => { if (!busy) void refresh(); }, POLL_MS);
}

window.addEventListener('unload', () => { if (pollTimer) clearInterval(pollTimer); });
document.addEventListener('DOMContentLoaded', start);
