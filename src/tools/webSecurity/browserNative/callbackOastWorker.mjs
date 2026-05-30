import { randomUUID, X509Certificate } from "node:crypto";
import dgram from "node:dgram";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const statePath = process.argv[2];
if (!statePath) throw new Error("callbackOastWorker requires statePath");

const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_RETRY_MS = 25;
const STATE_LOCK_STALE_MS = 30_000;
const TEXTUAL_CONTENT_TYPE = /(?:^|[\s;/+.-])(text|json|xml|html|javascript|ecmascript|x-www-form-urlencoded|svg|graphql)(?:[\s;/+.-]|$)/i;

const runtime = { httpServer: null, httpsServer: null, dnsServer: null, shuttingDown: false, maxRuntimeTimer: null };

function asString(value) {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function positiveInt(value, fallback) {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameStateFileWithRetry(tempPath, finalPath) {
  const retryCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rename(tempPath, finalPath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryCodes.has(error?.code || "")) throw error;
      await sleep(Math.min(250, 10 + attempt * 15));
    }
  }
  await rm(tempPath, { force: true }).catch(() => {});
  throw lastError;
}

function isProcessAlive(pid) {
  const n = typeof pid === "number" ? pid : typeof pid === "string" ? Number(pid) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

async function isStaleStateLock(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    const acquiredAt = Date.parse(String(parsed.acquiredAt || ""));
    const ageMs = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : Number.POSITIVE_INFINITY;
    const pid = Number(parsed.pid);
    if (Number.isInteger(pid)) return !isProcessAlive(pid) || ageMs > STATE_LOCK_STALE_MS * 20;
    return ageMs > STATE_LOCK_STALE_MS;
  } catch {
    try {
      const info = await stat(lockPath);
      return Date.now() - info.mtimeMs > STATE_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
}

async function stateLockExists(lockPath) {
  try {
    await stat(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readLockToken(value) {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.token === "string" ? value.token : undefined;
}

async function loadLockToken(lockPath) {
  try {
    return readLockToken(JSON.parse(await readFile(lockPath, "utf8")));
  } catch {
    return undefined;
  }
}

async function releaseStateLock(lockPath, token) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    if (parsed.token !== token) return;
    await rm(lockPath, { force: true });
  } catch {}
}

async function removeLockIfUnchanged(lockPath, expectedToken) {
  if (expectedToken) {
    const currentToken = await loadLockToken(lockPath);
    if (currentToken !== expectedToken) return;
  }
  await rm(lockPath, { force: true }).catch(() => {});
}

async function waitForStateLockBreaker(breakerPath, started) {
  while (await stateLockExists(breakerPath)) {
    if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock breaker: ${breakerPath}`);
    await sleep(STATE_LOCK_RETRY_MS);
  }
}

async function breakStaleStateLock(lockPath, breakerPath, started) {
  const token = randomUUID();
  let handle;
  let created = false;
  try {
    handle = await open(breakerPath, "wx");
    created = true;
    await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }), "utf8");
    await handle.close();
    handle = undefined;
    const staleToken = await loadLockToken(lockPath);
    if (await isStaleStateLock(lockPath)) await removeLockIfUnchanged(lockPath, staleToken);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await rm(breakerPath, { force: true }).catch(() => {});
    if (error?.code !== "EEXIST") throw error;
    if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock breaker: ${breakerPath}`);
  } finally {
    if (created) await releaseStateLock(breakerPath, token);
  }
}

async function withStateLock(fn) {
  const dir = path.dirname(statePath);
  const lockPath = `${statePath}.lock`;
  const breakerPath = `${lockPath}.breaker`;
  const started = Date.now();
  await mkdir(dir, { recursive: true });
  while (true) {
    await waitForStateLockBreaker(breakerPath, started);
    const token = randomUUID();
    let created = false;
    let handle;
    try {
      handle = await open(lockPath, "wx");
      created = true;
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }), "utf8");
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (created) await rm(lockPath, { force: true }).catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      if (await isStaleStateLock(lockPath)) await breakStaleStateLock(lockPath, breakerPath, started);
      else if (Date.now() - started >= STATE_LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for callback OAST state lock: ${lockPath}`);
      await sleep(STATE_LOCK_RETRY_MS);
      continue;
    }
    try {
      return await fn();
    } finally {
      await releaseStateLock(lockPath, token);
    }
  }
}

function normalizeHeaders(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, raw] of Object.entries(value)) {
    if (!name || raw === undefined || raw === null) continue;
    out[name] = Array.isArray(raw) ? raw.map((item) => asString(item) || "").join(", ") : asString(raw) || JSON.stringify(raw);
  }
  return out;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`callbackOastWorker state file is invalid JSON: ${error?.message || String(error)}`);
  }
}

async function saveStateUnlocked(state) {
  const dir = path.dirname(statePath);
  const tmp = path.join(dir, `.${path.basename(statePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await renameStateFileWithRetry(tmp, statePath);
}

async function updateState(update) {
  return await withStateLock(async () => {
    const current = await loadState();
    const next = await update(current);
    await saveStateUnlocked(next || current);
    return next || current;
  });
}

function callbackPath(basePath, correlationId) {
  const raw = asString(basePath)?.trim() || "/__pi_oast/{{correlationId}}";
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withSlash.includes("{{correlationId}}")) return withSlash.replaceAll("{{correlationId}}", encodeURIComponent(correlationId));
  return withSlash.endsWith("/") ? `${withSlash}${encodeURIComponent(correlationId)}` : `${withSlash}/${encodeURIComponent(correlationId)}`;
}

function callbackBaseUrl(protocol, host, port) {
  const hostname = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}://${hostname}:${port}`;
}

function parseJsonSafe(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function correlationMatched(correlationId, fields) {
  if (!correlationId) return false;
  const needle = String(correlationId);
  return fields.some((value) => String(value || "").includes(needle));
}

async function appendEvent(event) {
  await updateState((state) => {
    const events = Array.isArray(state.events) ? [...state.events] : [];
    const nextSeq = positiveInt(state.nextSeq, 1);
    const persisted = { ...event, seq: nextSeq, timestamp: new Date().toISOString(), correlationId: state.correlationId };
    events.push(persisted);
    const maxEvents = Math.min(100_000, positiveInt(state.maxEvents, 1000));
    while (events.length > maxEvents) events.shift();
    state.events = events;
    state.eventCount = events.length;
    state.nextSeq = nextSeq + 1;
    state.lastEventAt = persisted.timestamp;
    return state;
  });
}

function collectRequestBody(req, maxBodyBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBodyBytes - total;
      if (remaining > 0) {
        const slice = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
        chunks.push(slice);
        total += slice.byteLength;
      }
      if (buffer.byteLength > remaining) truncated = true;
    });
    req.on("end", () => resolve({ buffer: Buffer.concat(chunks), truncated }));
  });
}

async function handleHttpRequest(protocol, req, res) {
  const state = await loadState();
  const maxBodyBytes = Math.min(10_000_000, positiveInt(state.maxBodyBytes, 64_000));
  const { buffer, truncated } = await collectRequestBody(req, maxBodyBytes);
  const contentType = String(req.headers["content-type"] || "");
  const textual = TEXTUAL_CONTENT_TYPE.test(contentType) || !contentType;
  const text = textual ? buffer.toString("utf8") : "";
  const baseUrl = protocol === "https" ? state.httpsCallbackUrl || state.callbackUrl : state.callbackUrl;
  const event = {
    protocol,
    transport: protocol,
    method: req.method || "GET",
    url: req.url || "/",
    path: (() => { try { return new URL(req.url || "/", baseUrl).pathname; } catch { return req.url || "/"; } })(),
    query: (() => { try { return Object.fromEntries(new URL(req.url || "/", baseUrl).searchParams.entries()); } catch { return {}; } })(),
    headers: req.headers,
    headerNames: Object.keys(req.headers),
    remoteAddress: req.socket.remoteAddress,
    remotePort: req.socket.remotePort,
    matchedCorrelation: correlationMatched(state.correlationId, [req.url, text, ...Object.entries(req.headers).flatMap(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value])]),
    body: { bytes: buffer.length, truncated, text, base64: textual ? undefined : buffer.toString("base64"), json: textual ? parseJsonSafe(text) : undefined },
  };
  await appendEvent(event);
  res.writeHead(Math.min(599, Math.max(100, positiveInt(state.responseStatus, 200))), normalizeHeaders(state.responseHeaders));
  res.end(asString(state.responseBody) ?? "ok\n");
}

function dnsTypeName(type) {
  return ({ 1: "A", 12: "PTR", 16: "TXT", 28: "AAAA", 255: "ANY" })[type] || `TYPE${type}`;
}

function parseDnsQuestion(buffer) {
  const id = buffer.readUInt16BE(0);
  const qdcount = buffer.readUInt16BE(4);
  let offset = 12;
  const questions = [];
  for (let i = 0; i < qdcount; i += 1) {
    const labels = [];
    while (offset < buffer.length) {
      const length = buffer[offset++];
      if (length === 0) break;
      if ((length & 0xc0) === 0xc0) throw new Error("compressed DNS questions are unsupported");
      labels.push(buffer.subarray(offset, offset + length).toString("utf8"));
      offset += length;
    }
    const type = buffer.readUInt16BE(offset); offset += 2;
    const qclass = buffer.readUInt16BE(offset); offset += 2;
    questions.push({ name: labels.join("."), type, typeName: dnsTypeName(type), class: qclass });
  }
  return { id, qdcount, questions, questionEndOffset: offset };
}

function encodeDnsName(name) {
  const parts = String(name || "").replace(/\.+$/, "").split(".").filter(Boolean);
  const chunks = [];
  for (const part of parts) {
    const label = Buffer.from(part, "utf8");
    chunks.push(Buffer.from([label.length]), label);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function parseIpv4Address(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return undefined;
    const current = Number(part);
    return Number.isInteger(current) && current >= 0 && current <= 255 ? current : undefined;
  });
  return octets.every((part) => part !== undefined) ? octets : undefined;
}

function buildDnsResponse(query, responseAddress) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(query.qdcount, 4);
  const firstQuestion = query.questions[0];
  const ip = firstQuestion && firstQuestion.type === 1 ? parseIpv4Address(responseAddress) : undefined;
  const hasAAnswer = firstQuestion && firstQuestion.type === 1 && ip;
  header.writeUInt16BE(hasAAnswer ? 1 : 0, 6);
  const typeAndClass = Buffer.alloc(4);
  typeAndClass.writeUInt16BE(firstQuestion?.type || 1, 0);
  typeAndClass.writeUInt16BE(firstQuestion?.class || 1, 2);
  const question = Buffer.concat([encodeDnsName(firstQuestion?.name || ""), typeAndClass]);
  if (!hasAAnswer) return Buffer.concat([header, question]);
  const answer = Buffer.concat([
    Buffer.from([0xc0, 0x0c]),
    Buffer.from([0x00, 0x01, 0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x3c]),
    Buffer.from([0x00, 0x04, ip[0], ip[1], ip[2], ip[3]]),
  ]);
  return Buffer.concat([header, question, answer]);
}

async function handleDnsMessage(msg, remote, socket) {
  const state = await loadState();
  let parsed;
  try {
    parsed = parseDnsQuestion(msg);
  } catch (error) {
    await appendEvent({
      protocol: "dns",
      transport: "udp",
      matchedCorrelation: false,
      remoteAddress: remote.address,
      remotePort: remote.port,
      error: error instanceof Error ? error.message : String(error),
      queryBytes: msg.length,
    });
    return;
  }
  const responseAddress = asString(state.dnsResponseAddress) || "127.0.0.1";
  const response = buildDnsResponse(parsed, responseAddress);
  socket.send(response, remote.port, remote.address);
  const questionNames = parsed.questions.map((item) => item.name);
  await appendEvent({
    protocol: "dns",
    transport: "udp",
    queryId: parsed.id,
    queryName: questionNames[0],
    questionNames,
    questionTypes: parsed.questions.map((item) => item.typeName),
    remoteAddress: remote.address,
    remotePort: remote.port,
    matchedCorrelation: correlationMatched(state.correlationId, questionNames),
    queryBytes: msg.length,
    responseBytes: response.length,
  });
}

function dnsCallbackHost(state) {
  const base = asString(state.dnsBaseDomain)?.trim() || "local.pi-oast.test";
  return `${state.correlationId}.${base}`.replace(/^\.+|\.+$/g, "");
}

async function httpsCredentialsFromState(state) {
  const keyPath = asString(state.httpsKeyPath)?.trim();
  const certPath = asString(state.httpsCertPath)?.trim();
  if (!keyPath || !certPath) throw new Error("HTTPS_CERT_GENERATION_FAILED:httpsKeyPath/httpsCertPath missing from callback session state");
  const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
  return { key, cert };
}

function certificateInfo(certPem) {
  const cert = new X509Certificate(certPem);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    fingerprint256: cert.fingerprint256,
  };
}

async function start() {
  const state = await loadState();
  const basePath = callbackPath(state.basePath, state.correlationId);
  const listenHost = asString(state.listenHost)?.trim() || "127.0.0.1";
  const httpServer = http.createServer((req, res) => handleHttpRequest("http", req, res).catch(async (error) => {
    await appendEvent({ protocol: "http", error: error instanceof Error ? error.message : String(error), matchedCorrelation: false });
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("callback listener error\n");
  }));
  runtime.httpServer = httpServer;
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(positiveInt(state.port, 0), listenHost, () => { httpServer.off("error", reject); resolve(); });
  });
  const httpAddress = httpServer.address();
  if (!httpAddress || typeof httpAddress !== "object") throw new Error("callbackOastWorker could not determine HTTP listener address");
  state.port = httpAddress.port;
  state.callbackUrl = `${callbackBaseUrl("http", listenHost, httpAddress.port)}${basePath}`;
  state.basePath = basePath;
  state.publicBaseUrl = asString(state.publicBaseUrl)?.replace(/\/+$/, "") || undefined;
  state.publicCallbackUrl = state.publicBaseUrl ? `${state.publicBaseUrl}${basePath}` : undefined;

  if (state.enableHttps === true) {
    const credentials = await httpsCredentialsFromState(state);
    const httpsServer = https.createServer({ key: credentials.key, cert: credentials.cert }, (req, res) => handleHttpRequest("https", req, res).catch(async (error) => {
      await appendEvent({ protocol: "https", error: error instanceof Error ? error.message : String(error), matchedCorrelation: false });
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("callback listener error\n");
    }));
    runtime.httpsServer = httpsServer;
    await new Promise((resolve, reject) => {
      httpsServer.once("error", reject);
      httpsServer.listen(positiveInt(state.httpsPort, 0), listenHost, () => { httpsServer.off("error", reject); resolve(); });
    });
    const httpsAddress = httpsServer.address();
    if (!httpsAddress || typeof httpsAddress !== "object") throw new Error("callbackOastWorker could not determine HTTPS listener address");
    state.httpsPort = httpsAddress.port;
    state.httpsCallbackUrl = `${callbackBaseUrl("https", listenHost, httpsAddress.port)}${basePath}`;
    state.publicHttpsBaseUrl = asString(state.publicHttpsBaseUrl)?.replace(/\/+$/, "") || state.publicBaseUrl?.replace(/^http:/, "https:");
    state.publicHttpsCallbackUrl = state.publicHttpsBaseUrl ? `${state.publicHttpsBaseUrl}${basePath}` : undefined;
    state.httpsCertificate = certificateInfo(credentials.cert);
  }

  if (state.enableDns === true) {
    if (!parseIpv4Address(state.dnsResponseAddress)) throw new Error(`callbackOastWorker dnsResponseAddress must be a valid IPv4 address for DNS A-record responses: ${state.dnsResponseAddress}`);
    const dnsServer = dgram.createSocket("udp4");
    runtime.dnsServer = dnsServer;
    dnsServer.on("message", (msg, remote) => handleDnsMessage(msg, remote, dnsServer).catch(() => {}));
    await new Promise((resolve, reject) => {
      dnsServer.once("error", reject);
      dnsServer.bind(positiveInt(state.dnsPort, 0), asString(state.dnsListenHost)?.trim() || listenHost, () => { dnsServer.off("error", reject); resolve(); });
    });
    const dnsAddress = dnsServer.address();
    if (!dnsAddress || typeof dnsAddress !== "object") throw new Error("callbackOastWorker could not determine DNS listener address");
    state.dnsListenHost = dnsAddress.address;
    state.dnsPort = dnsAddress.port;
    state.dnsCallbackHost = dnsCallbackHost(state);
    state.publicDnsBaseDomain = asString(state.publicDnsBaseDomain)?.trim() || undefined;
    state.publicDnsCallbackHost = state.publicDnsBaseDomain ? `${state.correlationId}.${state.publicDnsBaseDomain}` : undefined;
  }

  state.workerPid = process.pid;
  state.listenerActive = true;
  state.recovered = false;
  state.ready = true;
  state.startedAt = state.startedAt || new Date().toISOString();
  const maxRuntimeMs = positiveInt(state.maxRuntimeMs, 60 * 60 * 1000);
  state.maxRuntimeMs = maxRuntimeMs;
  await updateState((current) => ({
    ...current,
    ...state,
    events: Array.isArray(current.events) ? current.events : [],
    eventCount: Array.isArray(current.events) ? current.events.length : 0,
    nextSeq: positiveInt(current.nextSeq, positiveInt(state.nextSeq, 1)),
    lastEventAt: current.lastEventAt,
    lastClearedAt: current.lastClearedAt,
  }));
  if (runtime.maxRuntimeTimer) clearTimeout(runtime.maxRuntimeTimer);
  runtime.maxRuntimeTimer = setTimeout(() => {
    void shutdown("max_runtime_exceeded");
  }, maxRuntimeMs);
}

async function shutdown(reason) {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  const close = async (server) => {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  };
  if (runtime.maxRuntimeTimer) {
    clearTimeout(runtime.maxRuntimeTimer);
    runtime.maxRuntimeTimer = null;
  }
  await Promise.all([close(runtime.httpServer), close(runtime.httpsServer), close(runtime.dnsServer)]).catch(() => {});
  try {
    await updateState((state) => {
      state.listenerActive = false;
      state.ready = false;
      state.stoppedAt = new Date().toISOString();
      state.stopReason = reason;
      return state;
    });
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("sigterm"));
process.on("SIGINT", () => shutdown("sigint"));
process.on("uncaughtException", async (error) => {
  try {
    await updateState((state) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.listenerActive = false;
      state.ready = false;
      state.stoppedAt = new Date().toISOString();
      return state;
    });
  } catch {}
  process.exit(1);
});

await start();
