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
};

let pollTimer = null;
let busy = false;

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
  render(await queryStatus());
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
      render(await queryStatus());
    }
  } finally {
    busy = false;
    el.action.disabled = false;
  }
}

function start() {
  setVersion();
  el.action.addEventListener('click', onAction);
  void refresh();
  pollTimer = setInterval(() => { if (!busy) void refresh(); }, POLL_MS);
}

window.addEventListener('unload', () => { if (pollTimer) clearInterval(pollTimer); });
document.addEventListener('DOMContentLoaded', start);
