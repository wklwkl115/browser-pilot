import { randomUUID, X509Certificate } from "node:crypto";
import dgram from "node:dgram";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const statePath = process.argv[2];
if (!statePath) throw new Error("callbackOastWorker requires statePath");

const TEXTUAL_CONTENT_TYPE = /(?:^|[\s;/+.-])(text|json|xml|html|javascript|ecmascript|x-www-form-urlencoded|svg|graphql)(?:[\s;/+.-]|$)/i;
const HTTPS_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC/TY4EGbXxmmzk
SVbDJfiBwhvGM8NfZ6MkTnOXnwvO/DS9mZJo+yHltw7JIMF8XtT82NOlost5Rvgs
+g4AdXixYWq7llaRD1Fr+rj8IeDFx0Kl8iqsJaypujmz7/hV0vNtp7r70DVBGvQ4
7NSTqv8OJ3DRtQ34XAjxlSdzBlIavbo38OGiQBlKG3WcJC/Cx9asJBTslI/p5aUK
XTZgJjIgI2nIdynIPQ4cRb3ZDCmvKsnnrBCGWPUnucwHb756nfirl7UUMBTNFRpT
DEnjZcWLMpwbRIqtDPl+Lu3XBayfyiVgv8cTfPX3zONMuB6NyNGlUtZYwE8xSBiC
4wH1VES9AgMBAAECggEALsXQBLmijg1TNWenAnSss1EZyFaMnK1yqmRSB863rOZm
ILtFHEzWh1tADrXnCLkI+z8qVDOe6yqKcDi9JqiSF1B5r5680J+9qRh2lRLVaZXj
+j3g6BEYC7F//TodbiJzKSra4UmRU7c64hYpjWdAEB5di7BoV4JtH1/38rwnY+j1
pOlIYvSB7ywWWQca2j0P7BQNz7AFlKUQmQMh0bow5ytIxInOtQPNc0CTCESSoc1k
ZMCBHHoyO4khwAR4JqdU5DxortpBWVn8NHXjMwFSJtrkqAsstvEIHlQ0JQ9aT/nj
rVg9Dro3OYrRsyaLeZy3MuZ5drpn++HHYQtrt+YbIQKBgQD2FptCou+JZYXYFwzK
63WQUXJ9OH7OOtQuZbNy958K8ZYGFICwnGOTTo0kivCPDFFmXhQiiJjY2WZ/TGCH
XAA3kyvx88FTWsQkBNxzyaYAfP3HVnKyGZ6trhykgzrzomcoOtn8fTKKP2VforOs
ucX3Mtj62yoqfRyw4ATDV8tYrQKBgQDHAg/CSSLOmx2x87i+KxyXUjPb6VJLnVcF
eu3DG2SgLKPelNLFFCHYkao3JdZY7Tg01//8rIdf4gvtkGgVBAYISzKTVCZQmDca
a9Z8KZLTQ4kLEvaxFonQlHtXLshDpyJWXYFbP0UoQ2ZFsxqmZ4kRNHPL5Oy/sALu
neUHyWrOUQKBgGgUa5olW3Ya8B7SsOBp8ZEWQXvglxEWJINzFBB91lBEmRT9Ouh3
XE4DHQLlmJSHuy22gIGSkEK2v/j7DqBxMs5OenmchJmCfA5X1/1IveLa+mKCl4Pn
/gqq5wZVUmuUtlh3e5akROnfojpuj9tvvuCsKsT+SLkrrSTJunn7+c8JAoGARxL3
ad4Q7lT74Ag5XMGs7mZPWyUTXSoOYEitDdeEsqf+xonEVNqB1AUCE7wRt6TRRB44
sJc1qgrjU68VXRwYw3GH2JJfNL2IQIlvCt0WMRmXojrdnBV+lt3QxyxQHcldPBcd
Eeeg3WZk6lOzGuczTs+644EZBMTp5yrBF2zaFmECgYEA1hohFB+Id0002VRHFf3w
kmIzPwyPZI5fRSCEKqmBRcCbvV6/MopJIMj4rnocQFCriUDgELcq3mcFb5+mCCfi
tvoQsLP7pfagfiK+cEKao1qeYt5BWPq7uaQyhuRAHOLqPXc0kfesASHYGUXfk0tN
wVMKRtG7S8sdj72QTKhpdEQ=
-----END PRIVATE KEY-----`;
const HTTPS_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUQiKEBrKVqUSDT3e582do58qex+gwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUxODEzMTQyM1oXDTM2MDUx
NTEzMTQyM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAv02OBBm18Zps5ElWwyX4gcIbxjPDX2ejJE5zl58Lzvw0
vZmSaPsh5bcOySDBfF7U/NjTpaLLeUb4LPoOAHV4sWFqu5ZWkQ9Ra/q4/CHgxcdC
pfIqrCWsqbo5s+/4VdLzbae6+9A1QRr0OOzUk6r/Didw0bUN+FwI8ZUncwZSGr26
N/DhokAZSht1nCQvwsfWrCQU7JSP6eWlCl02YCYyICNpyHcpyD0OHEW92QwpryrJ
56wQhlj1J7nMB2++ep34q5e1FDAUzRUaUwxJ42XFizKcG0SKrQz5fi7t1wWsn8ol
YL/HE3z198zjTLgejcjRpVLWWMBPMUgYguMB9VREvQIDAQABo1MwUTAdBgNVHQ4E
FgQUeNqISWIBj9Sgi5g/Ow8U3Z6+r5UwHwYDVR0jBBgwFoAUeNqISWIBj9Sgi5g/
Ow8U3Z6+r5UwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIvmE
lPDU6FrybEh0tAxnnBpGS1fjvgcuhlBVZQWy5D+hCGgZmsCwzmF1vC2nQMWWGx7/
lnloroOmhsKdsZQIjrgC9B2XqppyxtRPUqzsPVS8202Ri/C/xfZP25hhxvt5wXxf
4olw2OHGKkA8EeMywYkFL/j05YBKyN9ekYIMtDaNcvAVvaJdFEFG8D2PQUCvRiDo
XwLdsYx8gNzXil2G2GTgA7ILoI/nXzf3ILoRP1EIUou5pqRdnshL5i/ZhhZUXC0k
Hm8bLe667mPANwUjr1DMcmpsr0uUvw0zwSvSDvpxdGvsQnnYx0hLeP1yS56uIIrg
y6MvYSdcdoVmQWD+RA==
-----END CERTIFICATE-----`;

const runtime = { httpServer: null, httpsServer: null, dnsServer: null, shuttingDown: false };

function asString(value) {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function positiveInt(value, fallback) {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
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
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function saveState(state) {
  const dir = path.dirname(statePath);
  const tmp = path.join(dir, `.${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, statePath);
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
  const state = await loadState();
  const events = Array.isArray(state.events) ? state.events : [];
  const nextSeq = positiveInt(state.nextSeq, 1);
  const persisted = { ...event, seq: nextSeq, timestamp: new Date().toISOString(), correlationId: state.correlationId };
  events.push(persisted);
  const maxEvents = Math.min(100_000, positiveInt(state.maxEvents, 1000));
  while (events.length > maxEvents) events.shift();
  state.events = events;
  state.eventCount = events.length;
  state.nextSeq = nextSeq + 1;
  state.lastEventAt = persisted.timestamp;
  await saveState(state);
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

function buildDnsResponse(query, responseAddress) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(query.qdcount, 4);
  const firstQuestion = query.questions[0];
  const hasAAnswer = firstQuestion && firstQuestion.type === 1 && responseAddress;
  header.writeUInt16BE(hasAAnswer ? 1 : 0, 6);
  const question = Buffer.concat([encodeDnsName(firstQuestion?.name || ""), Buffer.from([0, firstQuestion?.type || 1, 0, firstQuestion?.class || 1])]);
  if (!hasAAnswer) return Buffer.concat([header, question]);
  const ip = responseAddress.split(".").map((item) => Math.max(0, Math.min(255, Number(item) || 0)));
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

function certificateInfo() {
  const cert = new X509Certificate(HTTPS_CERT_PEM);
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
    const httpsServer = https.createServer({ key: HTTPS_KEY_PEM, cert: HTTPS_CERT_PEM }, (req, res) => handleHttpRequest("https", req, res).catch(async (error) => {
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
    state.httpsCertificate = certificateInfo();
  }

  if (state.enableDns === true) {
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
  await saveState(state);
}

async function shutdown(reason) {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  const close = async (server) => {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  };
  await Promise.all([close(runtime.httpServer), close(runtime.httpsServer), close(runtime.dnsServer)]).catch(() => {});
  try {
    const state = await loadState();
    state.listenerActive = false;
    state.ready = false;
    state.stoppedAt = new Date().toISOString();
    state.stopReason = reason;
    await saveState(state);
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("sigterm"));
process.on("SIGINT", () => shutdown("sigint"));
process.on("uncaughtException", async (error) => {
  try {
    const state = await loadState();
    state.error = error instanceof Error ? error.message : String(error);
    state.listenerActive = false;
    state.ready = false;
    state.stoppedAt = new Date().toISOString();
    await saveState(state);
  } catch {}
  process.exit(1);
});

await start();
