import { readFileSync, existsSync, readdirSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bridge = path.join(root, "bridge", "pi_browser_bridge");

function resolveReadPath(rel) {
	if (path.isAbsolute(rel)) return rel;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(rel);
	if (drivePath) return process.platform === "win32" ? rel : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, rel);
}

function read(rel) {
	return readFileSync(resolveReadPath(rel), "utf8");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function readToolSources() {
	return readdirSync(path.join(root, "src", "tools"))
		.filter((file) => file.endsWith(".ts"))
		.map((file) => read(path.join("src", "tools", file)))
		.join("\n");
}

function stripBridgeSource(text) {
	return text
		.replace(/^\/\/ @ts-nocheck\r?\n/, "")
		.replace(/^import\s+[^;]+;\r?\n/gm, "")
		.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
		.replace(/^export async function /gm, "async function ")
		.replace(/^export function /gm, "function ")
		.replace(/^export class /gm, "class ")
		.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
		.replace(/\r?\n\/\/ ESM module metadata\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
		.replace(/^export const __piBridgeModule_[\s\S]*?;\s*$/gm, "")
		.replace(/\r?\nexport \{\};\s*$/, "");
}

function transformBridgeSource(text, sourcefile) {
	const stripped = stripBridgeSource(text);
	const rawComment = stripped.split(/\r?\n/).map((line) => `// raw:${line}`).join("\n");
	return `${rawComment}\n${transformSync(stripped, { loader: "ts", target: "chrome120", sourcefile }).code}`;
}
function readBridgeRuntimeFile(file) {
	const name = file.replace(/\.js$/, "");
	if (file === "hook_dispatcher.js" || file === "disable_dialogs.js" || file === "content.js") {
		return transformBridgeSource(read(`bridge_src/page_scripts/${name}.ts`).replace(/^import \{ TID \} from "\.\.\/shared\/protocol";\r?\n\r?\n/, 'const TID = "__pi_browser_bridge_request__";\n'), `bridge_src/page_scripts/${name}.ts`);
	}
	return transformBridgeSource(read(`bridge_src/service_worker/${name}.ts`), `bridge_src/service_worker/${name}.ts`);
}

function readBridgeBundle(files) {
	return files.map((file) => readBridgeRuntimeFile(file)).join("\n");
}

const requiredBridgeFiles = [
	"manifest.json",
	"popup.html",
	"popup.js",
	"native_command_schema.json",
	"dist/.gitignore",
];

for (const file of requiredBridgeFiles) {
	assert(existsSync(path.join(bridge, file)), `missing bridge file: ${file}`);
}

// Shared state_store stubs for VM sandboxes that load network/intercept modules
const stateStoreStubs = {
	registerRecovery: () => {},
	persistState: async () => ({ ok: true, generation: 0 }),
	forgetState: async () => ({ ok: true }),
	getState: async () => undefined,
	recoverState: async () => ({ kind: "", recovered: [], lost: [], diagnostics: [] }),
	RECOVERY_CODES: { RECOVERED: "RUNTIME_STATE_RECOVERED", RECOVERED_WITH_HISTORY_LOSS: "RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS", LOST: "RUNTIME_STATE_LOST" },
	redactConfig: (value) => value,
};

const pkg = JSON.parse(read("package.json"));
assert(pkg.version === "0.3.0", "package version must be 0.3.0");
assert(pkg.keywords?.includes("pi-package"), "package must declare pi-package keyword");
assert(pkg.pi?.extensions?.includes("./index.ts"), "package pi manifest must expose index.ts");
assert(pkg.main === "./dist/index.js", "package main must point to compiled dist entry");
assert(pkg.types === "./dist/index.d.ts", "package types must point to compiled declarations");
assert(pkg.exports?.["."]?.import === "./dist/index.js" && pkg.exports?.["."]?.types === "./dist/index.d.ts", "package exports must point to compiled dist entry and declarations");
assert(pkg.bin?.["pi-browser-mcp"] === "./dist/mcp/bin.js", "package MCP bin must point to compiled dist entry");
assert(pkg.scripts?.["sync:protocol"] === "node scripts/sync-native-protocol.mjs", "package must expose protocol sync script");
assert(pkg.scripts?.["sync:config"] === "node scripts/sync-bridge-config.mjs", "package must expose bridge config sync script");

const manifest = JSON.parse(read("bridge/pi_browser_bridge/manifest.json"));
assert(manifest.name === "Pi Native Browser Bridge", "manifest name must be Pi Native Browser Bridge");
assert(manifest.version === "0.3.0", "manifest version must be 0.3.0");
assert(manifest.background?.service_worker === "dist/service-worker.js" && manifest.background?.type === "module", "manifest must use generated dist module service worker");
assert(JSON.stringify(manifest.content_scripts?.[0]?.js) === JSON.stringify(["dist/disable_dialogs.js"]), "manifest document_start script must use dist disable-dialogs bundle");
assert(JSON.stringify(manifest.content_scripts?.[1]?.js) === JSON.stringify(["dist/content.js"]), "manifest document_idle script must use dist content bundle");
assert(manifest.permissions?.includes("downloads"), "manifest must include downloads permission for stable download paths");
assert(manifest.permissions?.includes("webNavigation"), "manifest must include webNavigation permission for wait.navigation event completion");

const serviceWorkerBridgeFiles = ["config.js", "protocol.js", "patterns.js", "cdp.js", "state_store.js", "runtime.js", "wait_cdp.js", "wait_coordinator.js", "wait_navigation.js", "wait_network_idle.js", "wait_selector.js", "wait.js", "network_model.js", "network.js", "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "ws_model.js", "ws.js", "router.js", "tab_sync.js", "transport.js"];
const background = serviceWorkerBridgeFiles.join(" ");
const transport = readBridgeRuntimeFile("transport.js");
const tabSync = readBridgeRuntimeFile("tab_sync.js");
const bridgeInfo = readBridgeRuntimeFile("bridge_info.js");
const router = readBridgeRuntimeFile("router.js");
const htmlBridge = readBridgeRuntimeFile("html.js");
const screenshotBridge = readBridgeRuntimeFile("screenshot.js");
const cdpBridge = readBridgeRuntimeFile("cdp.js");
const frameBridge = readBridgeRuntimeFile("frame.js");
const waitBridgeFiles = ["wait_cdp.js", "wait_coordinator.js", "wait_navigation.js", "wait_network_idle.js", "wait_selector.js", "wait.js"];
const waitBridge = readBridgeBundle(waitBridgeFiles);
const hookBridge = readBridgeRuntimeFile("hook.js");
const evidenceBridge = readBridgeRuntimeFile("evidence.js");
const networkBridge = readBridgeBundle(["network_model.js", "network_events.js", "network.js"]);
const patternsBridge = readBridgeRuntimeFile("patterns.js");
const hookDispatcher = readBridgeRuntimeFile("hook_dispatcher.js");
const coreCommands = readBridgeRuntimeFile("core_commands.js");
assert(bridgeInfo.includes("manifest.version_name || manifest.version"), "bridge_info must report display version_name when available");
assert(/\b(?:url|text)\s*===\s*["']about:blank["']/.test(bridgeInfo), "bridge tab tracking must include about:blank tabs created before navigation");
assert(/raw:\s*["']outer["']/.test(htmlBridge) && /fragment:\s*["']inner["']/.test(htmlBridge), "html.get must implement documented raw/fragment mode aliases");
assert(htmlBridge.includes("function sliceUtf8(str, limit)") && htmlBridge.indexOf("function sliceUtf8(str, limit)") < htmlBridge.indexOf("sliceUtf8(html, maxBytes)"), "html.get must define sliceUtf8 inside the page expression before maxBytes truncation");
assert(/error_code:\s*["']SELECTOR_NOT_FOUND["']/.test(htmlBridge) && /error_code:\s*["']INVALID_SELECTOR["']/.test(htmlBridge) && !/error_code:\s*["']SELECTOR_TIMEOUT["']/.test(htmlBridge), "html.get selector lookup must use stable selector-not-found/invalid-selector errors instead of timeout");
assert(cdpBridge.includes("grantUniversalAccess: Boolean(options?.grantUniversalAccess)") && !cdpBridge.includes("grantUniveralAccess"), "frame.evaluate must pass correctly-spelled CDP grantUniversalAccess option");
assert(frameBridge.includes("msg.grantUniversalAccess") && frameBridge.includes("options.grantUniversalAccess"), "frame.evaluate must forward top-level grantUniversalAccess to CDP options");
assert(
	/(?:tabId\s*:\s*Number\s*\(\s*tabId\s*\)|tabId:Number\(tabId\))/.test(frameBridge)
	&& /frames\s*:\s*Array\.isArray\s*\(\s*(?:data|fr\.data)\.frames\s*\)/.test(frameBridge)
	&& /frameId\s*:\s*String\s*\(\s*msg\.frameId\s*\)/.test(frameBridge),
	"frame commands must return tab-scoped structured frame list/evaluate metadata",
);
assert(waitBridgeFiles.at(-1) === "wait.js", "wait bridge bundle must keep wait.js as the final facade/dispatch script");
assert(waitBridgeFiles[0] === "wait_cdp.js" && waitBridgeFiles[1] === "wait_coordinator.js" && waitBridgeFiles.at(-1) === "wait.js", "wait helper modules must load before wait.js in VM fixtures");
assert(background.indexOf("runtime.js") < background.indexOf("wait_cdp.js") && background.indexOf("wait_cdp.js") < background.indexOf("wait_coordinator.js") && background.indexOf("wait_coordinator.js") < background.indexOf("wait_navigation.js") && background.indexOf("wait_navigation.js") < background.indexOf("wait_network_idle.js") && background.indexOf("wait_network_idle.js") < background.indexOf("wait_selector.js") && background.indexOf("wait_selector.js") < background.indexOf("wait.js"), "background.js must load wait helper modules before final wait.js facade");
for (const file of ["config.js", "protocol.js", "patterns.js", "cdp.js", "state_store.js", "runtime.js", "wait_cdp.js", "wait_coordinator.js", "wait_navigation.js", "wait_network_idle.js", "wait_selector.js", "wait.js", "network_model.js", "network.js", "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "router.js", "tab_sync.js", "transport.js"]) {
	assert(background.includes(file), `background.js must import ${file}`);
}
assert(background.indexOf("config.js") < background.indexOf("transport.js"), "background.js must load config.js before transport.js");
assert(background.indexOf("patterns.js") < background.indexOf("wait_cdp.js") && background.indexOf("wait_cdp.js") < background.indexOf("wait_coordinator.js") && background.indexOf("wait_coordinator.js") < background.indexOf("wait_navigation.js") && background.indexOf("wait_navigation.js") < background.indexOf("wait_network_idle.js") && background.indexOf("wait_network_idle.js") < background.indexOf("wait_selector.js") && background.indexOf("wait_selector.js") < background.indexOf("wait.js") && background.indexOf("patterns.js") < background.indexOf("network_model.js") && background.indexOf("network_model.js") < background.indexOf("network.js"), "background.js must load shared pattern helpers before wait helpers/facade, then network_model.js before network.js");
assert(background.indexOf("protocol.js") < background.indexOf("runtime.js"), "background.js must load protocol.js before runtime.js");
assert(background.indexOf("protocol.js") < background.indexOf("router.js"), "background.js must load protocol.js before router.js");
assert(background.indexOf("router.js") < background.indexOf("transport.js"), "background.js must load router.js before transport.js");
assert(background.indexOf("tab_sync.js") < background.indexOf("transport.js"), "background.js must load tab_sync.js before transport.js");

const forbiddenNaming = [
	/TMWD/i,
	/TMWebDriver/i,
	/GABrowser/i,
	/GA_BROWSER/,
	/__GA/,
	/__ga/,
	/gaBrowser/,
	/gaPersistent/,
	/BrowserPro/,
	/browserPro/,
	/native_hook_dispatcher/,
	/tmwd_cdp_bridge/,
];

for (const file of [...serviceWorkerBridgeFiles, "hook_dispatcher.js", "disable_dialogs.js"]) {
	const text = readBridgeRuntimeFile(file);
	new Function(text);
	for (const pattern of forbiddenNaming) {
		assert(!pattern.test(text), `${file} contains legacy naming: ${pattern}`);
	}
	assert(!text.includes("browser_pro"), `${file} must not contain browser_pro compatibility routing`);
}

const rootSchemaText = read("bridge/native_command_schema.json");
const bridgeSchemaText = read("bridge/pi_browser_bridge/native_command_schema.json");
const rootSchema = JSON.parse(rootSchemaText);
const schema = JSON.parse(bridgeSchemaText);
assert(JSON.stringify(schema) === JSON.stringify(rootSchema), "bridge native_command_schema.json must be generated from root schema");
for (const domain of ["core", "wait", "network", "intercept", "hook", "frame", "html", "screenshot", "evidence", "transfer"]) {
	assert(Array.isArray(schema.domains?.[domain]), `schema missing native domain: ${domain}`);
}
assert(schema.commands && typeof schema.commands === "object", "schema must define command specs");
for (const command of Object.values(schema.domains).flat()) {
	assert(schema.commands[command], `schema domains command missing spec: ${command}`);
}
const protocolSandbox = { self: {} };
vm.runInNewContext(readBridgeRuntimeFile("protocol.js"), protocolSandbox, { filename: "protocol.js" });
assert(JSON.stringify(protocolSandbox.self.PiNativeProtocol?.schema) === JSON.stringify(schema), "protocol.js must embed generated root schema");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "wait.selector", tabId: 1, selector: "body" })?.ok === true, "protocol validator must accept valid native commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "missing.command" })?.ok === false, "protocol validator must reject unknown commands");
const runtime = readBridgeRuntimeFile("runtime.js");
assert(runtime.includes("PI_BROWSER_PROTOCOL.nativeCommandMap"), "runtime native command map must come from protocol schema");
assert(runtime.includes("TAB_NOT_FOUND: 'TAB_NOT_FOUND'"), "runtime must expose a dedicated missing-tab error code for tab-scoped native commands");
assert(runtime.includes("SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND'") && runtime.includes("INVALID_SELECTOR: 'INVALID_SELECTOR'"), "runtime must expose stable selector error codes for non-wait selector commands");
assert(runtime.includes("const PI_BROWSER_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js';") && runtime.includes("window.__PI_BROWSER_HOOKS__ && window.__PI_BROWSER_HOOKS__.dispatch"), "runtime must keep the generated hook dispatcher filename and page global dispatch boundary stable");
assert(hookBridge.includes("chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PI_BROWSER_HOOK_DISPATCHER_FILE] })"), "hook bridge must inject the dispatcher through the stable file constant");
assert(hookBridge.includes("fetch(chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE))"), "hook bridge CDP fallback must fetch the same dispatcher file constant");
assert(hookDispatcher.includes(";(function PiBrowserHookDispatcher()") && hookDispatcher.includes("window.__PI_BROWSER_HOOKS__ = {"), "hook dispatcher must remain a self-contained page IIFE exposing window.__PI_BROWSER_HOOKS__");
assert(!/\bimport\s+|\bimport\s*\(|\bexport\s+|importScripts\s*\(/.test(hookDispatcher), "legacy hook dispatcher must remain self-contained until TODO 192 removes old runtime files");
assert(!/chrome\./.test(hookDispatcher), "hook dispatcher must stay free of background-only Chrome APIs");
assert(router.includes("validatePiBridgeProtocolMessage"), "router must validate commands through protocol schema");
assert(transport.includes("PI_BROWSER_BRIDGE_WS_URL") && transport.includes("PI_BROWSER_BRIDGE_HTTP_URL") && transport.includes("PI_BROWSER_BRIDGE_PORT_RANGE_END") && !transport.includes("127.0.0.1:18765"), "transport.js must read generated bridge URLs and port range instead of hardcoding the port");
assert(transport.split(/\r?\n/).filter((line) => !line.startsWith("// raw:")).length <= 230, "transport.js must stay focused on WebSocket lifecycle");
assert(transport.includes("cleanupTransportSocket") && transport.includes("if (current !== socket) continue"), "transport.js must use identity-guarded socket cleanup");
assert(transport.includes("sockets.set(port, socket)") && transport.includes("handlePiBridgeWsMessage(JSON.parse(event.data), socket)"), "transport.js handlers must capture the current socket instead of reading global socket state");
const scheduleProbeBlock = transport.slice(transport.indexOf("function scheduleProbe"), transport.indexOf("function bumpProbeBackoff"));
assert(scheduleProbeBlock.includes("chrome.alarms.create('pi-browser-ws-probe'"), "transport scheduleProbe must use the single named Chrome alarm for reconnect probes");
assert(!scheduleProbeBlock.includes("setTimeout("), "transport scheduleProbe must not create untracked setTimeout probe timers");
const socketOpenBlock = transport.slice(transport.indexOf("socket.onopen"), transport.indexOf("socket.onmessage"));
assert(socketOpenBlock.includes("wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS"), "transport must reset reconnect backoff after a successful WebSocket open");
assert(tabSync.includes("safeSendTabsUpdate") && tabSync.includes("runTabSyncTask"), "tab_sync.js must wrap async lifecycle tasks with rejection handling");
assert(!tabSync.includes("sendTabsUpdate();") && !tabSync.includes("void probeAndConnectWS(false);"), "tab_sync.js listeners must not fire async tasks without catch");
assert(/chrome\.tabs\.onRemoved\.addListener\(\(tabId\)\s*=>\s*\{\s*cleanupPiBrowserTab\(tabId,\s*['"]tab_removed['"]\)/s.test(tabSync), "tab removal must route through unified tab cleanup before sending tabs_update");
assert(runtime.includes("function cleanupPiBrowserTab(tabId, reason)") && runtime.includes("cleanupPiBrowserPageListenersForTab(tabId, cleanupReason)") && runtime.includes("cleanupNetworkRecorderTab(tabId, cleanupReason)") && runtime.includes("cleanupInterceptSessionTab(tabId, cleanupReason)") && runtime.includes("cleanupTabWaits(tabId, cleanupReason, { includeCdp: true") && runtime.includes("cancelWaitsForTab(tabId, 'tab_cleanup')"), "cleanupPiBrowserTab must release page listeners, queues, waits, interception state, CDP refs, and network recorders for removed tabs");
assert(
	/function\s+cleanupTabWaits\s*\(\s*tabId\s*,\s*reason\s*,\s*options(?:\s*=\s*\{\})?\s*\)/.test(waitBridge)
	&& waitBridge.includes("cleanupPiBrowserCdpTab(tabId, cleanupReason)")
	&& waitBridge.includes("cleanupEventSubscriptionsForTab(tabId)")
	&& waitBridge.includes("remaining_waits"),
	"wait cleanup must remove tab-scoped active waits, event subscriptions, and CDP refs",
);
assert(waitBridge.includes("wait.any requires waits/conditions") && waitBridge.includes("wait.all requires waits/conditions"), "wait.any/all must reject empty composite wait condition sets");
assert(
	waitBridge.includes("eventSubscriptionKey(tabId, listenerId)")
	&& waitBridge.includes("eventSubscription(listenerId, tabId)")
	&& waitBridge.includes("deleteEventSubscription(listenerId, tabId)")
	&& /\.filter\s*\(\s*\(?[A-Za-z_$][\w$]*\)?\s*=>\s*Number\s*\(\s*[A-Za-z_$][\w$]*\.tabId\s*\)\s*===\s*Number\s*\(\s*tabId\s*\)/.test(waitBridge),
	"wait/hook diagnostics and listener removal must stay scoped to the target tab",
);
assert(waitBridge.includes("callPagePiBrowser(tabId, 'hook.status'") && waitBridge.includes("callPagePiBrowser(tabId, 'hook.evaluate'"), "wait.diagnose must not auto-reinstall hook dispatchers as a read-only diagnostic command");
assert(waitBridge.includes("document.querySelectorAll('iframe')") && waitBridge.includes("window.frames") && !waitBridge.includes("document.frames"), "wait.diagnose frame probe must use iframe nodes/window.frames instead of non-standard document.frames");
assert(waitBridge.includes("function normalizePiBrowserWaitKind") && waitBridge.includes("replace(/[._-]/g") && waitBridge.includes("waitForNavigation(tabId, msg)"), "wait.any/all child dispatch must accept full native wait command names such as wait.loadState/wait.selector/wait.navigation");
assert(waitBridge.includes("wait.navigation immediate check failed") && waitBridge.includes("currentNavigationState") && !waitBridge.includes("if (timeoutMs === 0) { cleanupWait(record, 'immediate'); return { ok: true"), "wait.navigation timeoutMs=0 must perform a real current-state probe instead of unconditional success");
assert(hookBridge.includes("const explicitTab = msg && (msg.tabId !== undefined || msg.targetTabId !== undefined)") && hookBridge.includes("sessionEntries.length") && hookBridge.includes("callPagePiBrowser(tabId, 'hook.collect'"), "hook list/status/collect must respect explicit target scope and avoid read-only auto reinstall");
assert(evidenceBridge.includes("callPagePiBrowser(tabId, 'hook.status'") && evidenceBridge.includes("callPagePiBrowser(tabId, 'hook.collect'"), "evidence hook collection must preserve read-only no-reinstall semantics");
assert(networkBridge.includes("function cleanupNetworkRecorderTab(tabId, reason)") && networkBridge.includes("cleanupNetworkRecorder(recorder, reason || 'tab_cleanup', { keepBuffer:false })") && networkBridge.includes("piBrowserNetworkRecorders.delete(recorder.key)"), "network cleanup must stop and delete tab-scoped recorders on tab removal");
const interceptBridge = readBridgeRuntimeFile("intercept.js");
assert(interceptBridge.includes("normalizeInterceptRequestPatch") && interceptBridge.includes('"Fetch.continueRequest"') && interceptBridge.includes("mutationSummary") && !interceptBridge.includes("{ requestId, ...patch }"), "intercept continue path must normalize request mutation before Fetch.continueRequest and report mutationSummary instead of splatting raw patch");
assert(interceptBridge.includes("session.stages.map") && interceptBridge.includes('requestStage: stage === "response" ? "Response" : "Request"'), "intercept install must support bounded request/response stage selection when enabling Fetch interception patterns");
assert(networkBridge.includes("return getNetworkRecorder(tabId, sessionId);") && !networkBridge.includes("sessionId !== 'default' ? getNetworkRecorder(tabId, 'default')"), "network recorder lookup must not fall back from explicit sessionId to default");
assert(networkBridge.includes("const nextOffset = offset + items.length < all.length ? offset + items.length : null"), "network.list must return null nextOffset on the final page");
assert(networkBridge.includes("REQUEST_NOT_FOUND") && runtime.includes("REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND'"), "network.get missing request must use a dedicated REQUEST_NOT_FOUND error code");
assert(networkBridge.includes("function truncateBase64Body") && networkBridge.includes("btoa(decoded.slice(0, limit))"), "network body truncation must keep base64 output decodable by truncating decoded bytes and re-encoding");
assert(networkBridge.includes("const bodyRefs = new Set(records.map(r => r.bodyRef).filter(Boolean))"), "network.exportHar format=json must limit exported bodies to filtered records");
assert(networkBridge.includes("PI_BROWSER_NETWORK_DEFAULT_BODY_MIME_ALLOW") && networkBridge.includes("bodyMimeAllow") && networkBridge.includes("bodyAvailability"), "network recorder must expose bounded automatic body capture and body availability diagnostics");
assert(networkBridge.includes("captureRequestPostData !== false") && networkBridge.includes("maxPostDataSize: config.maxPostDataBytes"), "network recorder must capture bounded request postData by default and configure CDP postData size");
assert(
	patternsBridge.includes("PI_BROWSER_NETWORK_MAX_PATTERN_CHARS")
	&& patternsBridge.includes("isSafeNetworkRegexPattern")
	&& /\b(?:pattern|text)\.length\s*>\s*PI_BROWSER_NETWORK_MAX_PATTERN_CHARS/.test(patternsBridge),
	"shared pattern matching must bound user-controlled regex patterns",
);
assert(networkBridge.includes("matchNetworkPattern(url, p)") && waitBridge.includes("matchNetworkPattern(url, p)") && !waitBridge.includes("new RegExp(p)"), "network recorder and wait.networkIdle must use the shared safe pattern matcher");
assert(hookDispatcher.includes("PI_BROWSER_HOOK_MAX_REDACT_PATTERNS") && hookDispatcher.includes("PI_BROWSER_HOOK_REDACT_MAX_PATTERN_CHARS") && hookDispatcher.includes("isSafeHookRedactRegexPattern"), "hook dispatcher redact patterns must be bounded and safety-checked");
assert(hookDispatcher.includes("escapeRegExpLiteral") && !hookDispatcher.includes("new RegExp(String(p), 'gi')"), "hook dispatcher unsafe redact patterns must fall back to literal replacement instead of direct regex compilation");
assert(screenshotBridge.includes("getScreenshotTargetTab") && screenshotBridge.includes("TAB_NOT_FOUND") && screenshotBridge.includes("screenshot.capture target tab not found"), "screenshot.capture must return a clear missing-tab error before retry/fallback capture");
assert(screenshotBridge.includes("detachScreenshotDebugger") && screenshotBridge.includes("console.warn") && screenshotBridge.includes("debuggerDetach"), "screenshot.capture must surface debugger detach cleanup failures instead of swallowing them");
assert(screenshotBridge.includes("actualFormat = format === 'jpeg' ? 'jpeg' : 'png'") && screenshotBridge.includes("const mime = 'image/'") && !screenshotBridge.includes("format: format || 'png', fallback: 'captureVisibleTab'"), "screenshot visible-tab fallback must report the actual captured format/mime instead of the requested unsupported format");
assert(coreCommands.includes("normalizePiBrowserCreateTabUrl") && coreCommands.includes("javascript:") && coreCommands.includes("tabs.create requires an absolute URL"), "bridge tabs.create must validate malformed/script URLs before chrome.tabs.create");
assert(coreCommands.includes("function mergePiBrowserCookies") && coreCommands.includes("item.path") && coreCommands.includes("item.storeId") && coreCommands.includes("partitionKey"), "bridge cookie merging must preserve distinct path/store/partition cookie identities");
assert(coreCommands.includes("function normalizePiBrowserCookieUrl") && coreCommands.includes("unsupported_cookie_url_scheme") && !coreCommands.includes("url.match(/^https?"), "bridge cookie URL handling must validate non-http(s) URLs before origin extraction");
assert(router.includes("data.id === undefined") && router.includes("data.code === undefined") && !router.includes("if (!data.id || !data.code)"), "router.js must use nullish websocket envelope checks instead of falsy drops");
assert(router.includes("Message object must contain a non-empty") && router.includes("Unsupported message code type"), "router.js must return explicit malformed websocket input errors");
assert(router.includes("!Array.isArray(p)") && /typeof\s+(?:\([^)]*\)\.)?p(?:\s+as\s+[^\n]+)?\.cmd\s*===\s*["']string["']|typeof\s+p\.cmd\s*===\s*["']string["']/.test(router), "router.js must only promote JSON string code to command mode when it contains cmd");
assert(cdpBridge.includes("piPersistentCdpSessions.size >= PI_PERSISTENT_CDP_MAX_SESSIONS"), "persistent CDP session limit must be enforced before new attach");
assert(coreCommands.includes("R.push(normalizeBridgeResponse(await handleTabsCommand(c), c.cmd))"), "batch tabs commands must reuse handleTabsCommand instead of forcing list semantics");
const artifactReaderSource = read("src/tools/artifactReader.ts");
assert(artifactReaderSource.includes("createReadStream") && artifactReaderSource.includes("readline.createInterface"), "browser_artifact text/search/sample readers must stay streaming");
const jsonModeStart = artifactReaderSource.indexOf('if (mode === "json") {');
const streamingModeStart = artifactReaderSource.indexOf('if (mode === "search") result', jsonModeStart);
assert(jsonModeStart >= 0 && streamingModeStart > jsonModeStart, "browser_artifact must keep a dedicated json branch before streaming modes");
const jsonModeBranch = artifactReaderSource.slice(jsonModeStart, streamingModeStart);
const streamingModeBranch = artifactReaderSource.slice(streamingModeStart);
assert(
	jsonModeBranch.includes("info.size > MAX_ARTIFACT_READ_BYTES")
	&& jsonModeBranch.includes('readFile(absPath, "utf8")')
	&& jsonModeBranch.includes("redactArtifactResult(result, redact)"),
	"browser_artifact readFile path must stay isolated to json mode after size cap and feed the redacted output path",
);
assert(!streamingModeBranch.includes("readFile(absPath"), "browser_artifact text/search/sample paths must not use readFile");
assert(/if \(mode === "json"\) \{\s*if \(info\.size > MAX_ARTIFACT_READ_BYTES\)/s.test(jsonModeBranch), "browser_artifact size cap must apply to json readFile path, not streaming text/search/sample paths");
for (const forbidden of ["handleCookies", "handleBatch", "handleCDP", "handleTabsCommand", "chrome.scripting.executeScript", "validatePiBridgeProtocolMessage"]) {
	assert(!transport.includes(forbidden), `transport.js must not own command business logic: ${forbidden}`);
}

async function testNetworkRecorderBodyEvidence() {
	const cdpCalls = [];
	const bodies = new Map([
		["json-1", { body: "{\"ok\":true}", base64Encoded: false }],
		["large-1", { body: "0123456789", base64Encoded: false }],
		["fail-1", new Error("No resource with given identifier found")],
	]);
	const sandbox = {
		console,
		TextEncoder,
		AbortController,
		atob: globalThis.atob || ((text) => Buffer.from(String(text), "base64").toString("binary")),
		btoa: globalThis.btoa || ((text) => Buffer.from(String(text), "binary").toString("base64")),
		setTimeout,
		clearTimeout,
		PI_BROWSER_ERROR_CODES: {
			INTERNAL_ERROR: "INTERNAL_ERROR",
			NETWORK_RECORDER_NOT_STARTED: "NETWORK_RECORDER_NOT_STARTED",
			NETWORK_RECORDER_TIMEOUT: "NETWORK_RECORDER_TIMEOUT",
			BODY_UNAVAILABLE: "BODY_UNAVAILABLE",
			REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND",
			INVALID_RULE: "INVALID_RULE",
			ALREADY_INSTALLED: "ALREADY_INSTALLED",
			CANCELLED: "CANCELLED",
			TIMEOUT: "TIMEOUT",
		},
		piBrowserError: (code, message, details) => ({ ok: false, error_code: code, error: message, details }),
		redactSensitive: (value) => value,
		matchNetworkPattern: (value, pattern) => String(value || "").includes(String(pattern || "")),
		makeWaitId: (_tabId, prefix) => `${prefix || "id"}-${Math.random().toString(36).slice(2)}`,
		normalizePiBrowserTimeoutMs: (msg, fallback) => Number(msg?.timeoutMs ?? msg?.timeout_ms ?? fallback),
		enablePiBrowserCdpDomains: async (record, domains) => { record.cdpDomains = new Set(domains); record.cdpAttached = true; return { mode: "fake", domains }; },
		releasePiBrowserCdpDomains: () => ({ released: 0, disabled: 0 }),
		diagnosePiBrowserCdpDomainRefs: () => [],
		subscribePiBrowserCdp: (_tabId, _events, handler, record) => { sandbox.__networkHandler = handler; record.cdpSubscriptions.push("sub-1"); return "sub-1"; },
		unsubscribePiBrowserCdp: () => true,
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params, options) => {
				cdpCalls.push({ method, params, options });
				if (method === "Network.getResponseBody") {
					const value = bodies.get(params.requestId);
					if (value instanceof Error) throw value;
					return { ok: true, data: { result: value || { body: "", base64Encoded: false } } };
				}
				return { ok: true, data: { result: {} } };
			},
		}),
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (promise) => await promise,
		chrome: { debugger: { sendCommand: async () => ({}) } },
		...stateStoreStubs,
	};
	vm.runInNewContext(networkBridge, sandbox, { filename: "network.js" });
	const emit = (requestId, type, mimeType, postData) => {
		sandbox.__networkHandler({ tabId: 1 }, "Network.requestWillBeSent", {
			requestId,
			type,
			request: { url: `https://api.example.test/${requestId}`, method: postData === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, hasPostData: postData !== undefined, postData },
		});
		sandbox.__networkHandler({ tabId: 1 }, "Network.responseReceived", {
			requestId,
			type,
			response: { url: `https://api.example.test/${requestId}`, status: 200, statusText: "OK", mimeType, headers: { "Content-Type": mimeType } },
		});
		sandbox.__networkHandler({ tabId: 1 }, "Network.loadingFinished", { requestId, encodedDataLength: 10 });
	};
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	await sandbox.handleNetworkRecorderCommand(1, "network.start", { sessionId: "json" });
	emit("json-1", "XHR", "application/json;charset=UTF-8", "{\"q\":1}");
	await flush();
	const jsonGet = await sandbox.handleNetworkRecorderCommand(1, "network.get", { sessionId: "json", requestId: "json-1" });
	assert(jsonGet.ok && jsonGet.data.bodyAvailability === "captured", "network recorder must capture small JSON/XHR bodies by default");
	assert(jsonGet.data.bodyRef && jsonGet.data.bodyPreview === "{\"ok\":true}", "network recorder must expose bodyRef/bodyPreview for captured JSON bodies");
	assert(jsonGet.data.request.postData === "{\"q\":1}" && jsonGet.data.request.postDataTruncated === false, "network recorder must retain bounded request postData by default");
	const jsonBody = await sandbox.handleNetworkRecorderCommand(1, "network.body", { sessionId: "json", requestId: "json-1" });
	assert(jsonBody.ok && jsonBody.data.body === "{\"ok\":true}", "network.body must retrieve automatically captured response bodies");
	assert(jsonBody.data.bodyAvailability === "captured", "network.body must expose body availability on successful body reads");
	assert(cdpCalls.some(call => call.method === "Network.enable" && call.params?.maxPostDataSize), "network.start must configure CDP maxPostDataSize when retaining postData");

	await sandbox.handleNetworkRecorderCommand(1, "network.start", { sessionId: "off", captureBodies: false });
	emit("off-1", "XHR", "application/json", "{\"off\":true}");
	await flush();
	const offBody = await sandbox.handleNetworkRecorderCommand(1, "network.body", { sessionId: "off", requestId: "off-1" });
	assert(offBody.ok === false && offBody.details.bodyAvailability === "not_requested" && offBody.details.bodyUnavailableReason === "capture_bodies_disabled", "network.body must explain captureBodies:false misses");

	await sandbox.handleNetworkRecorderCommand(1, "network.start", { sessionId: "binary" });
	emit("bin-1", "XHR", "image/png");
	await flush();
	const binaryBody = await sandbox.handleNetworkRecorderCommand(1, "network.body", { sessionId: "binary", requestId: "bin-1" });
	assert(binaryBody.ok === false && binaryBody.details.bodyAvailability === "binary" && binaryBody.details.bodyUnavailableReason === "binary_mime", "network.body must expose binary/mime filtered misses");

	await sandbox.handleNetworkRecorderCommand(1, "network.start", { sessionId: "fail" });
	emit("fail-1", "XHR", "application/json");
	await flush();
	const failBody = await sandbox.handleNetworkRecorderCommand(1, "network.body", { sessionId: "fail", requestId: "fail-1" });
	assert(failBody.ok === false && failBody.details.bodyAvailability === "expired" && failBody.details.bodyUnavailableReason === "cdp_body_expired", "network.body must classify expired CDP response bodies");

	await sandbox.handleNetworkRecorderCommand(1, "network.start", { sessionId: "large", maxBodyBytes: 5 });
	emit("large-1", "Fetch", "application/json");
	await flush();
	const largeGet = await sandbox.handleNetworkRecorderCommand(1, "network.get", { sessionId: "large", requestId: "large-1" });
	assert(largeGet.ok && largeGet.data.bodyAvailability === "too_large" && largeGet.data.bodyTruncated === true, "network recorder must preserve truncated body refs with too_large availability");
}

await testNetworkRecorderBodyEvidence();

async function testInterceptSessionPrimitives() {
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		Date,
		Math,
		btoa: globalThis.btoa || ((text) => Buffer.from(String(text), "binary").toString("base64")),
		unescape,
		encodeURIComponent,
		PI_BROWSER_ERROR_CODES: {
			INTERNAL_ERROR: "INTERNAL_ERROR",
			INVALID_RULE: "INVALID_RULE",
			SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
			REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND",
		},
		piBrowserError: (code, message, details) => ({ ok: false, error_code: code, error: message, details }),
		redactSensitive: (value) => value,
		piBrowserPersistentCdp: () => ({
			send: async (_tabId, method, params) => ({ ok: true, data: { result: { method, ...params } } }),
		}),
		subscribePiBrowserCdp: (_tabId, _event, _handler) => "intercept-sub-1",
		unsubscribePiBrowserCdp: () => true,
		normalizePersistentPiBrowserResponse: (value) => value,
		...stateStoreStubs,
	};
	const interceptModelSource = readBridgeRuntimeFile("intercept_model.js");
	const interceptSource = readBridgeRuntimeFile("intercept.js");
	vm.runInNewContext(`${interceptModelSource}\n${interceptSource}\nglobalThis.__handlePiBrowserInterceptCommand = handlePiBrowserInterceptCommand; globalThis.__cleanupInterceptSessionTab = cleanupInterceptSessionTab; globalThis.__piBrowserInterceptSessions = piBrowserInterceptSessions;`, sandbox, { filename: "intercept.js" });
	const install = await sandbox.__handlePiBrowserInterceptCommand("intercept.install", 41, { cmd: "intercept.install", tabId: 41, sessionId: "contract" });
	assert(install.ok === true && install.data && install.data.active === true, `intercept.install must create an active session: ${JSON.stringify(install)}`);
	const addRule = await sandbox.__handlePiBrowserInterceptCommand("intercept.addRule", 41, { cmd: "intercept.addRule", tabId: 41, sessionId: "contract", action: "fulfill", matcher: { urlContains: "/bundle.js", stage: "response" }, patch: { body: "patched" } });
	assert(addRule.ok === true && addRule.data.rule.ruleId, "intercept.addRule must create a bounded rule");
	const status = await sandbox.__handlePiBrowserInterceptCommand("intercept.status", 41, { cmd: "intercept.status", tabId: 41, sessionId: "contract" });
	assert(status.ok === true && status.data.ruleCount === 1, "intercept.status must report rule count");
	const listed = await sandbox.__handlePiBrowserInterceptCommand("intercept.listRules", 41, { cmd: "intercept.listRules", tabId: 41, sessionId: "contract" });
	assert(listed.ok === true && listed.data.count === 1 && listed.data.rules[0].urlContains === "/bundle.js", "intercept.listRules must return structured rule summaries");
	const paused = await sandbox.__handlePiBrowserInterceptCommand("intercept.pause", 41, { cmd: "intercept.pause", tabId: 41, sessionId: "contract", autoApply: false, params: { requestId: "req-1", request: { url: "https://example.test/bundle.js", method: "GET" }, resourceType: "Script", responseStatusCode: 200 } });
	assert(paused.ok === true && paused.data.matchedRuleId === addRule.data.rule.ruleId, "intercept.pause must match explicit bounded rules");
	const fulfilled = await sandbox.__handlePiBrowserInterceptCommand("intercept.fulfill", 41, { cmd: "intercept.fulfill", tabId: 41, sessionId: "contract", requestId: "req-1", responseCode: 200, body: "patched-script" });
	assert(fulfilled.ok === true && fulfilled.data.fulfilled === true, "intercept.fulfill must resolve a paused request");
	const collected = await sandbox.__handlePiBrowserInterceptCommand("intercept.collect", 41, { cmd: "intercept.collect", tabId: 41, sessionId: "contract" });
	assert(collected.ok === true && collected.data.count >= 2, "intercept.collect must expose transcript evidence");
	const removed = await sandbox.__handlePiBrowserInterceptCommand("intercept.removeRule", 41, { cmd: "intercept.removeRule", tabId: 41, sessionId: "contract", ruleId: addRule.data.rule.ruleId });
	assert(removed.ok === true && removed.data.removed === true && removed.data.count === 0, "intercept.removeRule must remove existing rules");
	const uninstall = await sandbox.__handlePiBrowserInterceptCommand("intercept.uninstall", 41, { cmd: "intercept.uninstall", tabId: 41, sessionId: "contract" });
	assert(uninstall.ok === true && uninstall.data.uninstalled === true && uninstall.data.active === false, "intercept.uninstall must deactivate the target session");
	const statusAfterUninstall = await sandbox.__handlePiBrowserInterceptCommand("intercept.status", 41, { cmd: "intercept.status", tabId: 41, sessionId: "contract" });
	assert(statusAfterUninstall.ok === true && statusAfterUninstall.data.active === false, "intercept.status after uninstall must report inactive state");
	const continueAfterUninstall = await sandbox.__handlePiBrowserInterceptCommand("intercept.continue", 41, { cmd: "intercept.continue", tabId: 41, sessionId: "contract", requestId: "req-1" });
	assert(continueAfterUninstall.ok === false && continueAfterUninstall.error_code === "SESSION_NOT_FOUND", "intercept commands after uninstall must fail closed with SESSION_NOT_FOUND");
	const cleanup = sandbox.__cleanupInterceptSessionTab(41, "contract_cleanup");
	assert(cleanup.removed === 1 && sandbox.__piBrowserInterceptSessions.size === 0, "intercept cleanup must remove tab-scoped sessions");
}

await testInterceptSessionPrimitives();

async function testWsSessionPrimitives() {
	class FakeSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		url; protocols; readyState; sent; listeners;
		constructor(url, protocols) {
			this.url = url;
			this.protocols = protocols;
			this.readyState = FakeSocket.CONNECTING;
			this.sent = [];
			this.listeners = new Map();
		}
		addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
		removeEventListener(type, listener) { const list = (this.listeners.get(type) || []).filter((item) => item !== listener); this.listeners.set(type, list); }
		dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
		send(data) { this.sent.push(data); }
		close(code = 1000, reason = "") { this.readyState = FakeSocket.CLOSED; this.dispatch("close", { code, reason, wasClean: true }); }
	}
	const sandbox = {
		console,
		Date,
		Math,
		setTimeout,
		clearTimeout,
		TextEncoder,
		TextDecoder,
		Blob,
		WebSocket: FakeSocket,
		redactSensitive: (value) => value,
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE" },
		piBrowserError: (code, message, details) => ({ ok: false, error_code: code, error: message, details }),
		...stateStoreStubs,
	};
	const wsModelSource = readBridgeRuntimeFile("ws_model.js");
	const wsSource = readBridgeRuntimeFile("ws.js");
	vm.runInNewContext(`${wsModelSource}\n${wsSource}\nglobalThis.__handlePiBrowserWsCommand = handlePiBrowserWsCommand; globalThis.__cleanupWsSessionsForTab = cleanupWsSessionsForTab; globalThis.__piBrowserWsSessions = piBrowserWsSessions;`, sandbox, { filename: "ws.js" });
	const openPromise = sandbox.__handlePiBrowserWsCommand("ws.open", 51, { cmd: "ws.open", tabId: 51, sessionId: "contract", url: "ws://fixture/ws" });
	const session = sandbox.__piBrowserWsSessions.get("51:contract");
	assert(session, "ws.open must create a session record");
	const socket = session.ws;
	socket.readyState = FakeSocket.OPEN;
	socket.dispatch("open", {});
	const opened = await openPromise;
	assert(opened.ok === true && opened.data.session.state === "open", "ws.open must report open state");
	const sent = await sandbox.__handlePiBrowserWsCommand("ws.send", 51, { cmd: "ws.send", tabId: 51, sessionId: "contract", text: "ping" });
	assert(sent.ok === true && sent.data.sent.preview === "ping", "ws.send must append outbound transcript");
	const waitPromise = sandbox.__handlePiBrowserWsCommand("ws.wait", 51, { cmd: "ws.wait", tabId: 51, sessionId: "contract", contains: "pong", timeoutMs: 500 });
	socket.dispatch("message", { data: '{"type":"pong"}' });
	const waited = await waitPromise;
	assert(waited.ok === true && waited.data.entry.event === "message", "ws.wait must resolve on matched inbound transcript");
	const replayPromise = sandbox.__handlePiBrowserWsCommand("ws.replay", 51, { cmd: "ws.replay", tabId: 51, sessionId: "contract", steps: [{ text: "alpha", contains: "echo:alpha", timeoutMs: 200 }] });
	socket.dispatch("message", { data: "echo:alpha" });
	const replay = await replayPromise;
	assert(replay.ok === true && replay.data.steps.length === 1, "ws.replay must execute explicit bounded sequence steps");
	const replayFail = await sandbox.__handlePiBrowserWsCommand("ws.replay", 51, { cmd: "ws.replay", tabId: 51, sessionId: "contract", steps: [{ text: "beta", contains: "never-match", timeoutMs: 10 }] });
	assert(replayFail.ok === false && replayFail.details.stepIndex === 0 && Array.isArray(replayFail.details.partialTranscript), "ws.replay failure must expose step index and partial transcript diagnostics");
	const collected = await sandbox.__handlePiBrowserWsCommand("ws.collect", 51, { cmd: "ws.collect", tabId: 51, sessionId: "contract" });
	assert(collected.ok === true && collected.data.count >= 3, "ws.collect must expose transcript evidence");
	const unsafe = await sandbox.__handlePiBrowserWsCommand("ws.wait", 51, { cmd: "ws.wait", tabId: 51, sessionId: "contract", regex: "(a+)+$", timeoutMs: 50 });
	assert(unsafe.ok === false && unsafe.error_code === "WEBSOCKET_INVALID_MATCHER", "ws.wait must reject unsafe regex matchers");
	const closed = await sandbox.__handlePiBrowserWsCommand("ws.close", 51, { cmd: "ws.close", tabId: 51, sessionId: "contract" });
	assert(closed.ok === true, "ws.close must resolve cleanly");
	const cleanup = sandbox.__cleanupWsSessionsForTab(51, "contract_cleanup");
	assert(cleanup.removed === 1 && sandbox.__piBrowserWsSessions.size === 0, "ws cleanup must remove tab-scoped sessions");
}

await testWsSessionPrimitives();

async function testTransportSocketCleanupIdentity() {
	const alarms = [];
	const sockets = [];
	class FakeWebSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		constructor(url) {
			this.url = url;
			this.readyState = FakeWebSocket.CONNECTING;
			this.sent = [];
			sockets.push(this);
		}
		send(data) { this.sent.push(data); }
	}
	const sandbox = {
		PI_BROWSER_BRIDGE_HOST: "bridge.test",
		PI_BROWSER_BRIDGE_PORT: 18765,
		PI_BROWSER_BRIDGE_PORT_RANGE_END: 18765,
		PI_BROWSER_BRIDGE_WS_URL: "ws://bridge.test:18765",
		PI_BROWSER_BRIDGE_HTTP_URL: "http://bridge.test:18765",
		WebSocket: FakeWebSocket,
		AbortController,
		setTimeout,
		console: { log() {}, warn() {}, debug() {}, error() {} },
		fetch: async () => ({}),
		isScriptable: () => true,
		piBridgeInfo: () => ({ id: "bridge-test" }),
		installCspBypassRule() {},
		installPiBrowserTabSync(deps) { sandbox.tabSyncDeps = deps; },
		setBridgeWakeProbe(fn) { sandbox.bridgeWakeProbe = fn; },
		handlePiBridgeWsMessage: async () => {},
		chrome: {
			runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, reload() {} },
			alarms: { create(name, options) { alarms.push({ name, options }); }, onAlarm: { addListener(fn) { sandbox.onAlarm = fn; } } },
			tabs: { async query() { return [{ id: 1, url: "https://example.test", title: "Example", active: true, windowId: 1 }]; } },
		},
	};
	vm.runInNewContext(transport, sandbox, { filename: "transport.js" });
	assert(sandbox.installPiBrowserTransport() === true, "transport must install explicitly through the ESM service-worker entry");
	assert(sandbox.installPiBrowserTransport() === false, "transport install must be idempotent");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(sandbox.bridgeWakeProbe === sandbox.probeAndConnectWS, "transport must register bridge_wake probe through the command-layer hook");
	assert(sandbox.tabSyncDeps?.getSocket === sandbox.getPiBrowserTransportSocket && sandbox.tabSyncDeps?.getSockets === sandbox.getPiBrowserTransportSockets && sandbox.tabSyncDeps?.probe === sandbox.probeAndConnectWS, "transport must inject socket/probe dependencies into tab sync");
	assert(sockets.length === 1, "transport must create an initial socket after successful health probe");
	const first = sockets[0];
	first.readyState = FakeWebSocket.OPEN;
	await first.onopen();
	assert(first.sent.length === 1, "first socket should send ext_ready after open");
	first.readyState = FakeWebSocket.CLOSED;
	first.onerror({ type: "error" });
	assert(sandbox.getPiBrowserTransportSocket() === null, "non-open socket error must clear the current socket");
	assert(alarms.some((alarm) => alarm.name === "pi-browser-ws-probe"), "socket error cleanup must schedule reconnect probe");
	sandbox.connectWS();
	const second = sockets[1];
	assert(second, "transport should create a second socket after cleanup");
	second.readyState = FakeWebSocket.CONNECTING;
	first.onclose();
	assert(sandbox.getPiBrowserTransportSocket() === second, "late close from old socket must not clear the new socket");
	first.onerror({ type: "error" });
	assert(sandbox.getPiBrowserTransportSocket() === second, "late error from old socket must not clear the new socket");
	second.readyState = FakeWebSocket.OPEN;
	await second.onopen();
	assert(second.sent.length === 1, "second socket should send its own ext_ready");
}

async function testTransportMultiPortFanout() {
	const sockets = [];
	class FakeWebSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		constructor(url) {
			this.url = url;
			this.readyState = FakeWebSocket.CONNECTING;
			this.sent = [];
			sockets.push(this);
		}
		send(data) { this.sent.push(data); }
	}
	const sandbox = {
		PI_BROWSER_BRIDGE_HOST: "bridge.test",
		PI_BROWSER_BRIDGE_PORT: 18765,
		PI_BROWSER_BRIDGE_PORT_RANGE_END: 18766,
		PI_BROWSER_BRIDGE_WS_URL: "ws://bridge.test:18765",
		PI_BROWSER_BRIDGE_HTTP_URL: "http://bridge.test:18765",
		WebSocket: FakeWebSocket,
		AbortController,
		setTimeout,
		console: { log() {}, warn() {}, debug() {}, error() {} },
		fetch: async () => ({}),
		isScriptable: () => true,
		piBridgeInfo: () => ({ id: "bridge-test" }),
		installCspBypassRule() {},
		installPiBrowserTabSync(deps) { sandbox.tabSyncDeps = deps; },
		setBridgeWakeProbe(fn) { sandbox.bridgeWakeProbe = fn; },
		handlePiBridgeWsMessage: async () => {},
		chrome: {
			runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, reload() {} },
			alarms: { create() {}, onAlarm: { addListener(fn) { sandbox.onAlarm = fn; } } },
			tabs: {
				async query() { return [{ id: 1, url: "https://example.test", title: "Example", active: true, windowId: 1 }]; },
				onUpdated: { addListener() {} },
				onRemoved: { addListener() {} },
				onCreated: { addListener() {} },
			},
		},
	};
	vm.runInNewContext(transport, sandbox, { filename: "transport.js" });
	vm.runInNewContext(tabSync, sandbox, { filename: "tab_sync.js" });
	sandbox.installPiBrowserTransport();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(sockets.length === 2, "transport must connect to every live bridge server in the configured port range");
	assert(sockets.map((socket) => socket.url).join(" ").includes("18765") && sockets.map((socket) => socket.url).join(" ").includes("18766"), "transport sockets must target distinct bridge ports");
	for (const socket of sockets) { socket.readyState = FakeWebSocket.OPEN; await socket.onopen(); }
	await sandbox.sendTabsUpdate();
	assert(sockets.every((socket) => socket.sent.some((message) => String(message).includes('"tabs_update"'))), "tab sync must fan out updates to every open bridge socket");
}

await testTransportMultiPortFanout();

async function testHtmlGetSliceUtf8IsSelfContained() {
	const bridgeSandbox = {
		TextEncoder,
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", SELECTOR_TIMEOUT: "SELECTOR_TIMEOUT", SELECTOR_NOT_FOUND: "SELECTOR_NOT_FOUND", INVALID_SELECTOR: "INVALID_SELECTOR" },
		piBrowserError(code, error, details) { return { ok: false, error_code: code, error, details }; },
		piBrowserEval: async (_tabId, expression, awaitPromise) => {
			assert(awaitPromise === true, "html.get must request awaited page evaluation");
			const pageSandbox = {
				TextEncoder,
				document: {
					documentElement: { outerHTML: "A€BC", innerHTML: "A€BC", textContent: "A€BC" },
					querySelector() { return null; },
				},
			};
			assert(!("sliceUtf8" in pageSandbox), "test page sandbox must not provide a global sliceUtf8 helper");
			return { ok: true, data: await vm.runInNewContext(expression, pageSandbox, { filename: "html.get-expression.js" }) };
		},
	};
	vm.runInNewContext(`${htmlBridge}\nglobalThis.handlePiBrowserHtml = handlePiBrowserHtml;`, bridgeSandbox, { filename: "html.js" });
	assert(!("sliceUtf8" in bridgeSandbox), "html.js must not rely on a service-worker global sliceUtf8 helper");
	const result = await bridgeSandbox.handlePiBrowserHtml(7, { cmd: "html.get", maxBytes: 4 });
	assert(result?.ok === true, "html.get maxBytes case should succeed without global sliceUtf8");
	assert(result.data?.html === "A€", "html.get maxBytes must truncate at a UTF-8 boundary");
	assert(result.data?.bytes === 4 && result.data?.truncated === true, "html.get maxBytes must report truncated UTF-8 bytes");
}

await testHtmlGetSliceUtf8IsSelfContained();

async function testHtmlGetStructureMetadataBeforeTruncation() {
	const longHtml = "<section id='root'><a href='/1'>One</a><a href='/2'>Two</a><a href='/3'>Three</a><button>Go</button><form><input></form><img src='/x.png'><p>" + "x".repeat(200) + "</p></section>";
	const text = "One Two Three Go " + "x".repeat(200);
	const rootNode = {
		outerHTML: longHtml,
		innerHTML: longHtml.replace(/^<section[^>]*>|<\/section>$/g, ""),
		textContent: text,
		matches(tag) { return tag === "section"; },
		querySelectorAll(tag) {
			const counts = { a: 3, button: 1, input: 1, form: 1, img: 1, title: 0 };
			return Array.from({ length: counts[tag] || 0 }, () => ({ textContent: "" }));
		},
	};
	const bridgeSandbox = {
		TextEncoder,
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", SELECTOR_NOT_FOUND: "SELECTOR_NOT_FOUND", INVALID_SELECTOR: "INVALID_SELECTOR" },
		piBrowserError(code, error, details) { return { ok: false, error_code: code, error, details }; },
		piBrowserEval: async (_tabId, expression) => {
			const pageSandbox = {
				TextEncoder,
				document: {
					documentElement: rootNode,
					querySelector(selector) { return selector === "#root" ? rootNode : null; },
				},
			};
			return { ok: true, data: await vm.runInNewContext(expression, pageSandbox, { filename: "html.get-structure-expression.js" }) };
		},
	};
	vm.runInNewContext(`${htmlBridge}\nglobalThis.handlePiBrowserHtml = handlePiBrowserHtml;`, bridgeSandbox, { filename: "html.js" });
	const result = await bridgeSandbox.handlePiBrowserHtml(7, { cmd: "html.get", selector: "#root", maxChars: 80 });
	assert(result?.ok === true, "html.get structure metadata case should succeed");
	assert(result.data?.truncated === true && result.data?.html.length === 80, "html.get maxChars must still truncate explicitly requested capture");
	assert(result.data?.counts?.links === 3 && result.data?.counts?.buttons === 1 && result.data?.counts?.inputs === 1 && result.data?.counts?.forms === 1 && result.data?.counts?.images === 1, "html.get must return DOM structure counts computed before truncation");
	assert(result.data?.text_length === text.length, "html.get must return original DOM text length before truncation");
	assert(result.data?.original_length === longHtml.length && result.data?.original_bytes >= result.data?.bytes, "html.get must retain original length/bytes metadata");
}

await testHtmlGetStructureMetadataBeforeTruncation();

await testTransportSocketCleanupIdentity();

async function testTabSyncAsyncErrorsAreCaught() {
	const listeners = {};
	const debugLogs = [];
	let cleanupTabId;
	let queryImpl = async () => [{ id: 1, url: "https://example.test", title: "Example", active: true, windowId: 1 }];
	let socket = { readyState: 1, send() {} };
	let probeImpl = async () => {};
	const sandbox = {
		WebSocket: { OPEN: 1 },
		console: { debug(...args) { debugLogs.push(args); } },
		isScriptable: () => true,
		piBridgeInfo: () => ({ id: "bridge-test" }),
		getPiBrowserTransportSocket: () => socket,
		probeAndConnectWS: (...args) => probeImpl(...args),
		cleanupPiBrowserTab(tabId) { cleanupTabId = tabId; },
		chrome: {
			tabs: {
				query: (...args) => queryImpl(...args),
				onUpdated: { addListener(fn) { listeners.updated = fn; } },
				onRemoved: { addListener(fn) { listeners.removed = fn; } },
				onCreated: { addListener(fn) { listeners.created = fn; } },
			},
		},
	};
	vm.runInNewContext(tabSync, sandbox, { filename: "tab_sync.js" });
	sandbox.installPiBrowserTabSync({ getSocket: () => socket, probe: (...args) => probeImpl(...args) });
	queryImpl = async () => { throw new Error("query boom"); };
	listeners.updated(1, { status: "complete" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(debugLogs.some((entry) => entry[1]?.reason === "tabs.onUpdated" && entry[1]?.error === "query boom"), "tab_sync must catch tabs.query rejection");
	debugLogs.length = 0;
	queryImpl = async () => [{ id: 2, url: "https://example.test/ok", title: "OK", active: true, windowId: 1 }];
	socket = { readyState: 1, send() { throw new Error("send boom"); } };
	listeners.removed(22);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(cleanupTabId === 22, "tab_sync must still clean removed tabs");
	assert(debugLogs.some((entry) => entry[1]?.reason === "tabs.onRemoved" && entry[1]?.error === "send boom"), "tab_sync must catch ws.send exceptions");
	debugLogs.length = 0;
	probeImpl = async () => { throw new Error("probe boom"); };
	socket = { readyState: 1, send() {} };
	listeners.created();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert(debugLogs.some((entry) => entry[1]?.reason === "tabs.onCreated.probe" && entry[1]?.error === "probe boom"), "tab_sync must catch probe rejection from lifecycle hooks");
}

await testTabSyncAsyncErrorsAreCaught();

function testDialogSuppressionPromptSemantics() {
	const timers = [];
	const sandbox = {
		window: {},
		console: { log() {} },
		setTimeout(fn) { timers.push(fn); return timers.length; },
		document: {
			createElement() { return { style: {}, remove() {} }; },
			body: { appendChild() {} },
			documentElement: { appendChild() {} },
		},
	};
	vm.runInNewContext(readBridgeRuntimeFile("disable_dialogs.js"), sandbox, { filename: "disable_dialogs.js" });
	assert(sandbox.window.confirm("continue?") === true, "suppressed confirm must auto-accept");
	assert(sandbox.window.prompt("empty default", "") === "", "suppressed prompt must preserve empty-string default as accepted empty input");
	assert(sandbox.window.prompt("numeric default", 0) === "0", "suppressed prompt must stringify numeric default instead of returning null");
	assert(sandbox.window.prompt("boolean default", false) === "false", "suppressed prompt must stringify boolean default instead of returning null");
	assert(sandbox.window.prompt("missing default") === "", "suppressed prompt without default must return accepted empty input");
}

testDialogSuppressionPromptSemantics();

function testBridgeInfoTracksAboutBlankTabs() {
	const sandbox = {
		chrome: { runtime: { id: "bridge-test", getManifest: () => ({ name: "Pi Native Browser Bridge", version: "0.3.0", version_name: "0.3.0-test" }) } },
		navigator: { userAgent: "contract" },
		Math,
		Date,
	};
	vm.runInNewContext(`${bridgeInfo}
globalThis.__bridgeInfoTest = { isScriptable };`, sandbox, { filename: "bridge_info.js" });
	assert(sandbox.__bridgeInfoTest.isScriptable("https://example.test") === true, "http tabs must remain tracked");
	assert(sandbox.__bridgeInfoTest.isScriptable("about:blank") === true, "about:blank tabs created before navigation must be tracked");
	assert(sandbox.__bridgeInfoTest.isScriptable("chrome://extensions") === false, "internal chrome tabs must remain filtered");
}

testBridgeInfoTracksAboutBlankTabs();

function testBridgeInfoUsesTabScopedCspBypass() {
	const updates = [];
	const alarms = [];
	const alarmListeners = [];
	let now = 1_000;
	const sandbox = {
		chrome: {
			runtime: { id: "bridge-test", getManifest: () => ({ name: "Pi Native Browser Bridge", version: "0.3.0" }) },
			alarms: { create(name, info) { alarms.push({ name, ...info }); }, clear() { return true; }, onAlarm: { addListener(listener) { alarmListeners.push(listener); } } },
			declarativeNetRequest: {
				updateSessionRules(input) { updates.push({ kind: "session", ...input }); return Promise.resolve(); },
				updateDynamicRules(input) { updates.push({ kind: "dynamic", ...input }); return Promise.resolve(); },
			},
		},
		navigator: { userAgent: "contract" },
		Math,
		Date: { now: () => now },
		Number,
		console: { warn() {} },
	};
	vm.runInNewContext(`${bridgeInfo}
globalThis.__bridgeInfoCspTest = { installCspBypassRule, enableCspBypassForTab };`, sandbox, { filename: "bridge_info.js" });
	sandbox.__bridgeInfoCspTest.installCspBypassRule();
	assert(updates.at(-1).kind === "session" && updates.at(-1).addRules.length === 0, "install must clear legacy global CSP bypass rules through session-scoped rules instead of adding one");
	assert(sandbox.__bridgeInfoCspTest.enableCspBypassForTab(42, 1000) === true, "valid tab ids should enable scoped CSP bypass");
	const scopedRule = updates.at(-1).addRules[0];
	assert(scopedRule.condition.tabIds.length === 1 && scopedRule.condition.tabIds[0] === 42, "CSP bypass rule must be scoped to explicit tab ids");
	assert(scopedRule.condition.resourceTypes.includes("main_frame") && scopedRule.condition.resourceTypes.includes("sub_frame"), "CSP bypass must stay limited to frame responses");
	assert(sandbox.__bridgeInfoCspTest.enableCspBypassForTab("bad") === false, "invalid tab ids must not alter CSP bypass scope");
	assert(alarms.at(-1).name === "pi-browser-csp-bypass-prune", "CSP bypass cleanup must schedule an MV3 alarm");
	now = 3_000;
	alarmListeners.at(-1)({ name: "pi-browser-csp-bypass-prune" });
	assert(updates.at(-1).addRules.length === 0, "CSP bypass tab scope must expire and remove the rule");
}

testBridgeInfoUsesTabScopedCspBypass();

function testNetworkPatternMatchingIsBounded() {
	const compiledPatterns = [];
	class GuardedRegExp extends RegExp {
		constructor(pattern, flags) {
			const source = String(pattern);
			if (source === "(a+)+$") throw new Error("unsafe regex must not be compiled");
			compiledPatterns.push(source);
			super(pattern, flags);
		}
	}
	const sandbox = { RegExp: GuardedRegExp, TextEncoder, AbortController, console, ...stateStoreStubs };
	vm.runInNewContext(`${patternsBridge}
${networkBridge}
globalThis.__networkPatternTest = { matchNetworkPattern, makeNetworkRecorderFilter };`, sandbox, { filename: "network-patterns.js" });
	assert(sandbox.__networkPatternTest.matchNetworkPattern("https://example.test/api/users", "api/.*users") === true, "network patterns must keep simple regex matching");
	assert(compiledPatterns.includes("api/.*users"), "safe network regex patterns should still compile");
	assert(sandbox.__networkPatternTest.matchNetworkPattern("https://example.test/plain", "example.test/plain") === true, "network patterns must keep literal substring fallback semantics");
	assert(sandbox.__networkPatternTest.matchNetworkPattern(`${"a".repeat(80)}!`, "(a+)+$") === false, "unsafe nested regex pattern must not match by regex");
	assert(!compiledPatterns.includes("(a+)+$"), "unsafe nested regex pattern must not be compiled");
	assert(sandbox.__networkPatternTest.matchNetworkPattern("https://example.test/" + "a".repeat(20), "a".repeat(600)) === false, "oversized network patterns must be rejected instead of compiled");
	assert(!compiledPatterns.includes("a".repeat(600)), "oversized network pattern must not be compiled");
	const filter = sandbox.__networkPatternTest.makeNetworkRecorderFilter({ includeUrls: ["(a+)+$"], excludeUrls: [] });
	const result = filter({ request: { url: `${"a".repeat(80)}!`, method: "GET" }, type: "xhr" }, "request");
	assert(result.match === false && result.reason === "include_url", "network recorder filters must safely reject unsafe non-matching include regex");
}

testNetworkPatternMatchingIsBounded();

function testWaitNetworkIdlePatternMatchingIsBounded() {
	const compiledPatterns = [];
	class GuardedRegExp extends RegExp {
		constructor(pattern, flags) {
			const source = String(pattern);
			if (source === "(a+)+$") throw new Error("unsafe wait regex must not be compiled");
			compiledPatterns.push(source);
			super(pattern, flags);
		}
	}
	const sandbox = { RegExp: GuardedRegExp, AbortController, console };
	vm.runInNewContext(`${patternsBridge}
${waitBridge}
globalThis.__waitPatternTest = { compileNetworkIdleFilter };`, sandbox, { filename: "wait-patterns.js" });
	const unsafeInclude = sandbox.__waitPatternTest.compileNetworkIdleFilter({ includeUrls: ["(a+)+$"] });
	const includeResult = unsafeInclude({ url: `${"a".repeat(80)}!`, method: "GET", type: "xhr" });
	assert(includeResult.track === false && includeResult.reason === "not_included", "wait.networkIdle must safely reject unsafe non-matching include regex");
	assert(!compiledPatterns.includes("(a+)+$"), "wait.networkIdle unsafe nested regex must not be compiled");
	const safeInclude = sandbox.__waitPatternTest.compileNetworkIdleFilter({ includeUrls: ["api/.*users"] });
	assert(safeInclude({ url: "https://example.test/api/v1/users", method: "GET", type: "xhr" }).track === true, "wait.networkIdle must keep simple regex include matching");
	assert(compiledPatterns.includes("api/.*users"), "wait.networkIdle should still compile safe regex patterns");
}

testWaitNetworkIdlePatternMatchingIsBounded();

function testHookDispatcherRedactionPatternsAreBounded() {
	const compiledPatterns = [];
	class GuardedRegExp extends RegExp {
		constructor(pattern, flags) {
			const source = String(pattern);
			if (source === "(a+)+$") throw new Error("unsafe hook redact regex must not be compiled");
			if (source === "x".repeat(600)) throw new Error("oversized hook redact regex must not be compiled");
			compiledPatterns.push(source);
			super(pattern, flags);
		}
	}
	const posted = [];
	const listeners = {};
	const pageConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
	const pageWindow = {
		__PI_BROWSER_HOOKS__: undefined,
		postMessage(message) { posted.push(message); },
		addEventListener(type, handler) { listeners[type] = handler; },
		removeEventListener(type, handler) { if (listeners[type] === handler) delete listeners[type]; },
	};
	const sandbox = {
		window: pageWindow,
		console: pageConsole,
		RegExp: GuardedRegExp,
		Date,
		Math,
		setTimeout,
		clearTimeout,
	};
	vm.runInNewContext(hookDispatcher, sandbox, { filename: "hook_dispatcher.js" });
	const hooks = sandbox.window.__PI_BROWSER_HOOKS__;
	const install = hooks.install({
		session_id: "redact-session",
		targets: { console: true },
		options: { redact_patterns: ["token-[0-9]+", "(a+)+$", "x".repeat(600)] },
		buffer_size: 20,
	});
	assert(install.ok === true, "hook dispatcher test session must install");
	sandbox.console.log("token-123", "literal (a+)+$ should redact", "fixture-secret");
	const collected = hooks.collect({ limit: 20 });
	const serialized = JSON.stringify(collected.data.events);
	assert(serialized.includes("[REDACTED]"), "hook dispatcher must still redact matching values");
	assert(!serialized.includes("token-123") && !serialized.includes("fixture-secret") && !serialized.includes("(a+)+$"), "hook dispatcher must redact safe regex, defaults, and unsafe literal pattern matches");
	assert(compiledPatterns.includes("token-[0-9]+"), "hook dispatcher should keep simple safe custom regex redaction");
	assert(!compiledPatterns.includes("(a+)+$"), "hook dispatcher must not compile unsafe nested custom regex");
	assert(!compiledPatterns.includes("x".repeat(600)), "hook dispatcher must not compile oversized custom regex");
	assert(compiledPatterns.some((source) => source.includes("\\(a\\+\\)\\+\\$")), "hook dispatcher must literal-escape unsafe custom patterns");
	assert(posted.length > 0, "hook dispatcher should still emit observable hook events");
}

testHookDispatcherRedactionPatternsAreBounded();

function testHookDispatcherSessionCollectAndSeqContracts() {
	const posted = [];
	const listeners = {};
	const pageConsole = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
	const pageWindow = {
		__PI_BROWSER_HOOKS__: undefined,
		postMessage(message) { posted.push(message); },
		addEventListener(type, handler) { listeners[type] = handler; },
		removeEventListener(type, handler) { if (listeners[type] === handler) delete listeners[type]; },
	};
	const sandbox = {
		window: pageWindow,
		console: pageConsole,
		Date,
		Math,
		setTimeout,
		clearTimeout,
	};
	vm.runInNewContext(hookDispatcher, sandbox, { filename: "hook_dispatcher.js" });
	const hooks = sandbox.window.__PI_BROWSER_HOOKS__;
	const install = hooks.install({ session_id: "hook-contract-session", targets: { console: true }, buffer_size: 20 });
	assert(install.ok === true, "hook dispatcher must install the contract session");
	const badStatus = hooks.dispatch("hook.status", { session_id: "wrong-session" });
	assert(badStatus.ok === false && badStatus.error_code === "INVALID_SESSION", "hook.status must reject mismatched explicit sessionId");
	const badCollect = hooks.dispatch("hook.collect", { session_id: "wrong-session" });
	assert(badCollect.ok === false && badCollect.error_code === "INVALID_SESSION", "hook.collect must reject mismatched explicit sessionId");
	const badClear = hooks.dispatch("hook.clear_buffer", { session_id: "wrong-session" });
	assert(badClear.ok === false && badClear.error_code === "INVALID_SESSION", "hook.clear_buffer must reject mismatched explicit sessionId");
	const badUninstall = hooks.dispatch("hook.uninstall", { session_id: "wrong-session" });
	assert(badUninstall.ok === false && badUninstall.error_code === "INVALID_SESSION", "hook.uninstall must reject mismatched explicit sessionId");
	assert(hooks.dispatch("hook.status", { session_id: "hook-contract-session" }).ok === true, "failed mismatched uninstall must not clear the current session");

	const clearEmpty = hooks.clearBuffer({ session_id: "hook-contract-session" });
	assert(clearEmpty.ok === true, "hook.clear_buffer must accept the matching session");
	const emptyCollect = hooks.collect({ session_id: "hook-contract-session", limit: 20 });
	assert(emptyCollect.ok === true && emptyCollect.data.events.length === 0, "idle hook.collect after clear must not create lifecycle self-noise");

	sandbox.console.log("before-clear");
	const before = hooks.collect({ session_id: "hook-contract-session", limit: 20 });
	const beforeEvent = before.data.events.find((event) => event.type === "console.log");
	assert(beforeEvent, "console hook must produce an event before clear");
	const beforeSeq = beforeEvent.seq;
	const clear = hooks.clearBuffer({ session_id: "hook-contract-session" });
	assert(clear.ok === true && clear.data.last_seq >= beforeSeq, "hook.clear_buffer must report the current monotonic sequence");
	sandbox.console.log("after-clear");
	const after = hooks.collect({ session_id: "hook-contract-session", since_seq: beforeSeq, limit: 20 });
	const afterEvent = after.data.events.find((event) => event.type === "console.log");
	assert(afterEvent && afterEvent.seq > beforeSeq, "events created after hook.clear_buffer must keep monotonically increasing seq values");
}

testHookDispatcherSessionCollectAndSeqContracts();

async function testScreenshotMissingTabReturnsExplicitError() {
	let getCalls = 0;
	let attachCalls = 0;
	let captureCalls = 0;
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { TAB_NOT_FOUND: "TAB_NOT_FOUND", TIMEOUT: "TIMEOUT" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (value) => await value,
		piSleep: async () => {},
		chrome: {
			tabs: {
				async get(tabId) { getCalls += 1; throw new Error(`No tab with id: ${tabId}.`); },
				async captureVisibleTab() { captureCalls += 1; return "data:image/png;base64,AA=="; },
			},
			debugger: {
				async attach() { attachCalls += 1; },
				async sendCommand() { throw new Error("should not capture missing tab"); },
				async detach() {},
			},
		},
	};
	vm.runInNewContext(`${screenshotBridge}\nglobalThis.__screenshotTest = { captureScreenshotWithRetry };`, sandbox, { filename: "screenshot.js" });
	const result = await sandbox.__screenshotTest.captureScreenshotWithRetry(404, { cmd: "screenshot.capture", retries: 3, fallback: true });
	assert(result.ok === false && result.error_code === "TAB_NOT_FOUND", "missing screenshot tab must not be reported as timeout");
	assert(result.error === "screenshot.capture target tab not found" && result.details?.tabId === 404, "missing screenshot tab error must include clear command context");
	assert(getCalls === 1 && attachCalls === 0 && captureCalls === 0, "missing screenshot tab must short-circuit retries and visible-tab fallback");
}

await testScreenshotMissingTabReturnsExplicitError();

async function testScreenshotDetachWarningIsObservable() {
	const warnings = [];
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { TAB_NOT_FOUND: "TAB_NOT_FOUND", TIMEOUT: "TIMEOUT" },
		console: { warn(...args) { warnings.push(args); } },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (value) => await value,
		piSleep: async () => {},
		chrome: {
			tabs: {
				async get() { return { id: 7, windowId: 2 }; },
				async captureVisibleTab() { throw new Error("fallback should not run after debugger capture"); },
			},
			debugger: {
				async attach() {},
				async sendCommand() { return { data: "AA==" }; },
				async detach() { throw new Error("detach boom"); },
			},
		},
	};
	vm.runInNewContext(`${screenshotBridge}\nglobalThis.__screenshotTest = { captureScreenshotWithRetry };`, sandbox, { filename: "screenshot.js" });
	const result = await sandbox.__screenshotTest.captureScreenshotWithRetry(7, { cmd: "screenshot.capture", retries: 1, fallback: true });
	assert(result.ok === true && result.data?.method === "chrome.debugger", "screenshot debugger capture should still return captured evidence");
	assert(result.data?.cleanup?.debuggerDetach?.ok === false, "screenshot detach failure must be returned as observable cleanup metadata");
	assert(/detach boom/.test(result.data.cleanup.debuggerDetach.error), "screenshot detach warning must preserve the detach error text");
	assert(warnings.length === 1, "screenshot detach failure must be logged for extension diagnostics");
}

await testScreenshotDetachWarningIsObservable();

async function testScreenshotFallbackReportsActualFormat() {
	const captureOptions = [];
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { TAB_NOT_FOUND: "TAB_NOT_FOUND", TIMEOUT: "TIMEOUT" },
		console: { warn() {} },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		piWithTimeout: async (value) => await value,
		piSleep: async () => {},
		chrome: {
			tabs: {
				async get() { return { id: 8, windowId: 3 }; },
				async captureVisibleTab(_windowId, options) { captureOptions.push(options); return "data:image/png;base64,AA=="; },
			},
			debugger: {
				async attach() { throw new Error("debugger unavailable"); },
				async sendCommand() { throw new Error("should not reach debugger capture"); },
				async detach() {},
			},
		},
	};
	vm.runInNewContext(`${screenshotBridge}\nglobalThis.__screenshotTest = { captureScreenshotWithRetry };`, sandbox, { filename: "screenshot.js" });
	const result = await sandbox.__screenshotTest.captureScreenshotWithRetry(8, { cmd: "screenshot.capture", format: "webp", retries: 1, fallback: true });
	assert(result.ok === true && result.data?.fallback === "captureVisibleTab", "screenshot fallback should succeed when visible-tab capture works");
	assert(captureOptions[0]?.format === "png", "visible-tab fallback must request an actually supported Chrome capture format");
	assert(result.data?.format === "png" && result.data?.mime === "image/png", "visible-tab fallback must report actual png format/mime for unsupported requested webp");
	assert(/^data:image\/png;base64,/.test(result.data?.screenshot || ""), "visible-tab fallback evidence must remain a png data URL");
}

await testScreenshotFallbackReportsActualFormat();

async function testTabsCreateUrlValidation() {
	const created = [];
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", INTERNAL_ERROR: "INTERNAL_ERROR" },
		bridgeError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		URL,
		isScriptable: (url) => /^https?:/.test(String(url || "")) || url === "about:blank",
		piBridgeInfo: () => ({}),
		probeAndConnectWS() {},
		chrome: {
			tabs: {
				async query() { return [
					{ id: 1, url: "about:blank", title: "New Tab", active: true, windowId: 1 },
					{ id: 2, url: "https://example.test", title: "Example", active: false, windowId: 1 },
					{ id: 3, url: "chrome://extensions", title: "Extensions", active: false, windowId: 1 },
				]; },
				async update() { return { windowId: 1 }; },
				async create(options) { created.push(options); return { id: 9, url: options.url, title: "", windowId: 1 }; },
				async get() { return { url: "", title: "", windowId: 1 }; },
				async remove() {},
			},
			windows: { async update() {} },
		},
	};
	vm.runInNewContext(`${coreCommands}\nglobalThis.__tabsTest = { handleTabsCommand };`, sandbox, { filename: "core_commands.js" });
	const badRelative = await sandbox.__tabsTest.handleTabsCommand({ cmd: "tabs", method: "create", url: "example.com" });
	assert(badRelative.ok === false && badRelative.error_code === "INVALID_RULE" && /absolute URL/.test(badRelative.error), "tabs.create must reject relative or malformed URLs clearly");
	const badScript = await sandbox.__tabsTest.handleTabsCommand({ cmd: "tabs", method: "create", url: "javascript:alert(1)" });
	assert(badScript.ok === false && badScript.details?.protocol === "javascript:", "tabs.create must reject javascript URLs before chrome.tabs.create");
	const ok = await sandbox.__tabsTest.handleTabsCommand({ cmd: "tabs", method: "create", url: "https://example.test/path", active: false });
	assert(ok.ok === true && created.length === 1 && created[0].url === "https://example.test/path", "tabs.create must preserve valid absolute URLs");
	const defaultBlank = await sandbox.__tabsTest.handleTabsCommand({ cmd: "tabs", method: "create" });
	assert(defaultBlank.ok === true && created.at(-1).url === "about:blank" && defaultBlank.data?.url === "about:blank", "tabs.create without url must keep about:blank as the observable created tab URL");
	const listed = await sandbox.__tabsTest.handleTabsCommand({ cmd: "tabs", method: "list" });
	assert(listed.data.some((tab) => tab.url === "about:blank"), "tabs.list must include about:blank tabs created before navigation");
	assert(listed.data.some((tab) => tab.url === "https://example.test") && !listed.data.some((tab) => /^chrome:/.test(tab.url)), "tabs.list must keep http(s) tabs and filter internal chrome tabs");
}

await testTabsCreateUrlValidation();

async function testCookiesPreserveDistinctScopes() {
	const cookieQueries = [];
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", INTERNAL_ERROR: "INTERNAL_ERROR" },
		bridgeError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		URL,
		chrome: {
			tabs: { async get() { return { url: "https://example.test/admin/panel" }; } },
			cookies: {
				async getAll(query) {
					cookieQueries.push(query);
					if (query.partitionKey) return [
						{ name: "sid", value: "admin", domain: "example.test", path: "/admin", storeId: "0", partitionKey: { topLevelSite: "https://example.test" } },
						{ name: "sid", value: "partition-root", domain: "example.test", path: "/", storeId: "0", partitionKey: { topLevelSite: "https://example.test" } },
					];
					return [
						{ name: "sid", value: "root", domain: "example.test", path: "/", storeId: "0" },
						{ name: "prefs", value: "dark", domain: "example.test", path: "/", storeId: "0" },
					];
				},
			},
		},
	};
	vm.runInNewContext(`${coreCommands}\nglobalThis.__cookieTest = { handleCookies };`, sandbox, { filename: "core_commands.js" });
	const result = await sandbox.__cookieTest.handleCookies({ cmd: "cookies", url: "https://example.test/admin/panel" }, {});
	assert(result.ok === true, "cookies command should succeed for explicit URL");
	assert(result.data.length === 4, "cookies command must preserve same-name cookies across path and partition scopes");
	assert(result.data.some((cookie) => cookie.name === "sid" && cookie.path === "/" && cookie.value === "root" && !cookie.partitionKey), "cookies command must keep unpartitioned root cookie");
	assert(result.data.some((cookie) => cookie.name === "sid" && cookie.path === "/admin" && cookie.value === "admin" && cookie.partitionKey?.topLevelSite === "https://example.test"), "cookies command must keep partitioned path-specific cookie");
	assert(result.data.some((cookie) => cookie.name === "sid" && cookie.path === "/" && cookie.value === "partition-root" && cookie.partitionKey?.topLevelSite === "https://example.test"), "cookies command must keep partitioned root cookie distinct from unpartitioned root cookie");
	assert(cookieQueries.some((query) => query.partitionKey?.topLevelSite === "https://example.test"), "cookies command must still query partitioned cookies for the request origin");
	const queryCount = cookieQueries.length;
	const aboutBlank = await sandbox.__cookieTest.handleCookies({ cmd: "cookies", url: "about:blank" }, {});
	assert(aboutBlank.ok === true && Array.isArray(aboutBlank.data) && aboutBlank.data.length === 0 && aboutBlank.details?.reason === "unsupported_cookie_url_scheme", "cookies command must return an empty stable result for non-http(s) URLs");
	assert(cookieQueries.length === queryCount, "cookies command must not call chrome.cookies.getAll for unsupported URL schemes");
	const invalidUrl = await sandbox.__cookieTest.handleCookies({ cmd: "cookies", url: "example.test/no-scheme" }, {});
	assert(invalidUrl.ok === false && invalidUrl.error_code === "INVALID_RULE" && /valid absolute URL/.test(invalidUrl.error), "cookies command must reject malformed URLs without leaking internal null-match errors");
}

await testCookiesPreserveDistinctScopes();

async function testBatchTabsMethodsPreserveSemantics() {
	const calls = [];
	let nextCreatedId = 30;
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", INTERNAL_ERROR: "INTERNAL_ERROR", NO_SESSION: "NO_SESSION" },
		bridgeError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		normalizeBridgeResponse: (resp) => resp,
		URL,
		isScriptable: (url) => /^https?:/.test(String(url || "")),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		isPiNativeBrowserCommand: () => false,
		handlePiBridgeMessage: async () => ({ ok: false, error: "unexpected native" }),
		chrome: {
			tabs: {
				async query() { calls.push(["query"]); return [{ id: 1, url: "https://example.test", title: "One", active: true, windowId: 1 }]; },
				async update(tabId, options) { calls.push(["update", tabId, options]); return { id: tabId, url: "https://example.test/switched", title: "Switched", active: true, windowId: 7 }; },
				async create(options) { calls.push(["create", options]); return { id: nextCreatedId++, url: options.url, title: "Created", windowId: 8 }; },
				async get(tabId) { calls.push(["get", tabId]); return { id: tabId, url: "https://example.test/closed", title: "Closed", windowId: 9 }; },
				async remove(tabId) { calls.push(["remove", tabId]); },
			},
			windows: { async update(windowId, options) { calls.push(["window.update", windowId, options]); } },
		},
	};
	vm.runInNewContext(`${coreCommands}
globalThis.__batchTabsTest = { handleBatch };`, sandbox, { filename: "core_commands.js" });
	const result = await sandbox.__batchTabsTest.handleBatch({ cmd: "batch", commands: [
		{ cmd: "tabs", method: "create", url: "https://example.test/new", active: false },
		{ cmd: "tabs", method: "switch", tabId: 30 },
		{ cmd: "tabs", method: "close", targetTabId: 30 },
	] }, {});
	assert(result.ok === true && result.results.length === 3, "batch tabs methods should return one result per command");
	assert(result.results[0].data?.tabId === 30, "batch tabs.create must return created tab data, not a tab list");
	assert(result.results[1].ok === true, "batch tabs.switch must route through handleTabsCommand");
	assert(result.results[2].data?.tabId === 30, "batch tabs.close must return closed tab data");
	assert(calls.some(([name]) => name === "create"), "batch tabs.create must call chrome.tabs.create");
	assert(calls.some(([name]) => name === "update"), "batch tabs.switch must call chrome.tabs.update");
	assert(calls.some(([name]) => name === "remove"), "batch tabs.close must call chrome.tabs.remove");
	assert(!calls.some(([name]) => name === "query"), "batch non-list tabs methods must not be silently downgraded to tabs.list");
	const listResult = await sandbox.__batchTabsTest.handleBatch({ cmd: "batch", commands: [{ cmd: "tabs", method: "list" }] }, {});
	assert(listResult.results[0].data?.[0]?.id === 1 && calls.some(([name]) => name === "query"), "batch tabs.list must still list scriptable tabs");
}

await testBatchTabsMethodsPreserveSemantics();

async function testRouterWsMalformedInputErrors() {
	const sent = [];
	const execRequests = [];
	const validationInputs = [];
	const routerSandbox = {
		chrome: { runtime: { onMessage: { addListener() {} } } },
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE" },
		bridgeError: (_code, error, details) => ({ ok: false, error, details }),
		validatePiBridgeProtocolMessage: (msg) => { validationInputs.push(msg); return { ok: true, command: msg }; },
		handleBridgeWake: async () => ({ ok: true, data: {} }),
		handleCookies: async () => ({ ok: true, data: {} }),
		handleCDP: async () => ({ ok: true, data: {} }),
		handlePersistentCDP: async () => ({ ok: true, data: {} }),
		handleBatch: async () => ({ ok: true, data: {} }),
		handleTabsCommand: async () => ({ ok: true, data: {} }),
		handleManagementCommand: async () => ({ ok: true, data: {} }),
		handleContentSettingsCommand: async () => ({ ok: true, data: {} }),
		handlePiNativeBrowserCommand: async () => ({ ok: true, data: {} }),
		isPiNativeBrowserCommand: () => false,
		enableCspBypassForTab: () => {},
		dispatchPiBridgeCommand: async () => ({ ok: true, data: {} }),
		handleWsExec: async (data, socket) => { execRequests.push(data); socket.send(JSON.stringify({ type: "exec", id: data.id, code: data.code })); },
		socket: { send(text) { sent.push(JSON.parse(text)); } },
		console,
	};
	vm.runInNewContext(router, routerSandbox, { filename: "router.js" });
	await routerSandbox.handlePiBridgeWsMessage({ id: "empty-js", code: "", tabId: 3 }, routerSandbox.socket);
	assert(execRequests.length === 1, "router must not silently drop empty-string JavaScript code");
	assert(sent.at(-1).type === "exec" && sent.at(-1).id === "empty-js", "router must route empty-string code to exec path");
	await routerSandbox.handlePiBridgeWsMessage({ id: "missing-cmd", code: { selector: "body" }, tabId: 3 }, routerSandbox.socket);
	assert(sent.at(-1).type === "error" && /cmd/.test(sent.at(-1).error), "router must return explicit error for object code without cmd");
	assert(validationInputs.length === 0, "router must not run full protocol validation for object code without cmd");
	await routerSandbox.handlePiBridgeWsMessage({ id: "json-missing-cmd", code: "{\"selector\":\"body\"}" }, routerSandbox.socket);
	assert(sent.at(-1).type === "exec" && sent.at(-1).code === "{\"selector\":\"body\"}", "router must preserve JSON object strings without cmd as JavaScript source");
	await routerSandbox.handlePiBridgeWsMessage({ id: "json-array-js", code: "[]", tabId: 3 }, routerSandbox.socket);
	assert(sent.at(-1).type === "exec" && sent.at(-1).code === "[]", "router must preserve JSON array strings as JavaScript source");
	await routerSandbox.handlePiBridgeWsMessage({ id: "json-command", code: "{\"cmd\":\"tabs\",\"method\":\"list\"}", tabId: 3 }, routerSandbox.socket);
	assert(validationInputs.at(-1)?.cmd === "tabs", "router must still route JSON command strings with cmd through protocol validation");
	await routerSandbox.handlePiBridgeWsMessage({ id: "zero-code", code: 0 }, routerSandbox.socket);
	assert(sent.at(-1).type === "error" && /Unsupported message code type/.test(sent.at(-1).error), "router must not silently drop numeric code");
	const beforeIgnored = sent.length;
	await routerSandbox.handlePiBridgeWsMessage({ id: "missing-code" }, routerSandbox.socket);
	assert(sent.length === beforeIgnored, "router may ignore envelopes with nullish missing code before request registration");
}

await testRouterWsMalformedInputErrors();

async function testRouterNativeWsErrorFrames() {
	const sent = [];
	const routerSandbox = {
		chrome: { runtime: { onMessage: { addListener() {} } } },
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE" },
		bridgeError: (_code, error, details) => ({ ok: false, error, details }),
		validatePiBridgeProtocolMessage: (msg) => ({ ok: true, command: msg }),
		handleBridgeWake: async () => ({ ok: true, data: {} }),
		handleCookies: async () => ({ ok: true, data: {} }),
		handleCDP: async () => ({ ok: true, data: {} }),
		handlePersistentCDP: async () => ({ ok: true, data: {} }),
		handleBatch: async () => ({ ok: true, data: {} }),
		handleTabsCommand: async () => ({ ok: true, data: {} }),
		handleManagementCommand: async () => ({ ok: true, data: {} }),
		handleContentSettingsCommand: async () => ({ ok: true, data: {} }),
		handlePiNativeBrowserCommand: async () => ({ ok: false, error: "native boom", details: { cmd: "wait.selector" } }),
		isPiNativeBrowserCommand: (cmd) => cmd === "wait.selector",
		enableCspBypassForTab: () => {},
		dispatchPiBridgeCommand: async (msg) => msg.cmd === "wait.selector" ? { ok: false, error: "native boom", details: { cmd: "wait.selector" } } : { ok: true, data: {} },
		handleWsExec: async () => {},
		socket: { send(text) { sent.push(JSON.parse(text)); } },
		console,
	};
	vm.runInNewContext(router, routerSandbox, { filename: "router.js" });
	await routerSandbox.handlePiBridgeWsMessage({ id: "native-error", code: { cmd: "wait.selector", selector: "body", tabId: 1 } }, routerSandbox.socket);
	assert(sent.length === 1, "router native websocket path must send one frame");
	assert(sent[0].type === "error", "router native websocket path must emit error frames for failed native commands");
	assert(sent[0].error === "native boom", "router native websocket error frame must preserve native error text");
	assert(sent[0].result?.ok === false, "router native websocket error frame must keep the failed native result payload");
}

await testRouterNativeWsErrorFrames();

const serverSource = read("src/driver/BrowserBridgeServer.ts");
assert(serverSource.includes("validateBridgeCommand"), "server must validate bridge commands through protocol schema");
assert(serverSource.includes('methodAccessMode') && serverSource.includes('spec.accessMode'), "driver command access mode must come from protocol schema metadata");
assert(!serverSource.includes('schemaDrivenCommandAccessMode') && !serverSource.includes('cmd.startsWith("intercept.")'), "driver must not keep local write-command hardcoded routing once schema accessMode exists");
assert(!serverSource.includes("sendCommand(command: Record<string, unknown>"), "server sendCommand must not accept free-form Record commands");

const registerToolsSource = read("src/tools/registerTools.ts");
const toolSource = readToolSources();

const toolAdapterSource = read("src/tools/toolAdapter.ts");
function usesJsonDistillation(source) { return source.includes("distilledJsonResult") || (source.includes("jsonToolResult") && toolAdapterSource.includes("distilledJsonResult")); }
function usesTextDistillation(source) { return source.includes("distilledTextResult") || (source.includes("textToolResult") && toolAdapterSource.includes("distilledTextResult")); }
assert(registerToolsSource.split(/\r?\n/).length <= 60, "registerTools.ts must stay a thin composition entrypoint");
assert(!registerToolsSource.includes("registerTool({"), "registerTools.ts must not directly register individual tools");
assert(!registerToolsSource.includes("waitCommandForAction"), "registerTools.ts must not own domain action mapping");
for (const name of ["browser_tabs", "browser_execute", "browser_observe", "browser_pick", "browser_download", "browser_upload", "browser_wait", "browser_network", "browser_hook", "browser_evidence", "browser_frame", "browser_screenshot", "browser_artifact"]) {
	assert(toolSource.includes(`name: "${name}"`), `tool not registered: ${name}`);
}
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type"]) {
	assert(!toolSource.includes(`name: "${removed}"`), `removed split action tool must not be registered: ${removed}`);
}
assert(!toolSource.includes("PI_BROWSER_ENABLE_COMPAT_PRO"), "browser_pro compatibility gate must be removed");
assert(!toolSource.includes("name: \"browser_pro\""), "browser_pro tool must be removed");
assert(toolSource.includes("selectBrowser"), "browser selection action missing");
assert(usesTextDistillation(read("src/tools/observeRunners.ts")), "browser_observe must use result distillation middleware across scan/content/html modes");
assert(usesJsonDistillation(read("src/tools/registerPickTool.ts")), "browser_pick must use result distillation middleware");
assert(usesJsonDistillation(read("src/tools/registerEvidenceTool.ts")), "browser_evidence must use result distillation middleware");
assert(usesJsonDistillation(read("src/tools/registerNativeActionTools.ts")), "browser_network must use result distillation middleware through native action tools");
assert(read("src/tools/resultMiddleware.ts").includes("./summaries/index"), "result middleware must use split summary modules");
assert(toolSource.includes("call browser_tabs list/switch to pick a target tab"), "tab-scoped tools must warn agents to list/switch before automation");
assert(toolSource.includes("A tabId is NOT stable"), "tab-scoped tools must warn that a tabId is not stable across navigation");
assert(toolSource.includes("omit tabId to use the selected/active tab"), "tabId fallback warning missing from tool prompts");
assert((toolSource.match(/TAB_SCOPED_TOOL_GUIDELINE/g) || []).length >= 6, "tab-scoped tools must reuse explicit tabId guidance");
assert(((toolSource.match(/optionalTargetTabId\(/g) || []).length + (toolSource.match(/sharedTabScopedToolParams\(/g) || []).length) >= 6, "tab-scoped tabId parameters must reuse explicit fallback warning helper");
const skill = read("D:/Pi/agent/skills/pi-browser-tools/SKILL.md");
assert(skill.includes("tabId") && skill.includes("browser_tabs list"), "pi-browser-tools skill must document explicit tabId automation flow");
assert(skill.includes("browser_pick") && skill.includes("browser_observe"), "pi-browser-tools skill must document pick/observe flows");
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type"]) {
	assert(!skill.includes(removed), `pi-browser-tools skill must not document removed split action tool: ${removed}`);
}
assert(!skill.includes("npm run check") && !skill.includes("smoke:browser"), "pi-browser-tools skill must not contain project development validation flow");
assert(toolSource.includes("NativeCommandParamsSchema"), "native tools must use one generic params schema and protocol validation");
assert((toolSource.match(/params: Type.Optional\(NativeCommandParamsSchema\)/g) || []).length >= 3, "native tool params must use generic protocol-backed schema");
for (const forbidden of [
	"NativeWaitCommandParamSchemas",
	"NativeNetworkCommandParamSchemas",
	"NativeHookCommandParamSchemas",
	"NativeFrameCommandParamSchemas",
	"NativeHtmlCommandParamSchemas",
	"NativeEvidenceCommandParamSchemas",
	"NativeWaitParamsSchema",
	"NativeNetworkParamsSchema",
	"NativeHookParamsSchema",
	"NativeFrameParamsSchema",
	"NativeHtmlParamsSchema",
	"NativeEvidenceParamsSchema",
]) {
	assert(!toolSource.includes(forbidden), `registerTools.ts must not duplicate native command params schema: ${forbidden}`);
}
assert(toolSource.includes("outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION }))") || toolSource.includes("sharedTabScopedToolParams"), "scan output path option missing");

async function testCdpAliasReleaseAndFrameOptions() {
	const attachedTabs = new Set();
	const sendCalls = [];
	let detachCount = 0;
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		...stateStoreStubs,
		chrome: {
			tabs: { async update() {} },
			debugger: {
				async attach({ tabId }) {
					if (attachedTabs.has(Number(tabId))) throw new Error("Another debugger is already attached");
					attachedTabs.add(Number(tabId));
				},
				async detach({ tabId }) { detachCount += 1; attachedTabs.delete(Number(tabId)); },
				async sendCommand({ tabId }, method, params) {
					sendCalls.push({ tabId, method, params });
					if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "http://example.test/", name: "", mimeType: "text/html", securityOrigin: "http://example.test" } } };
					if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
					if (method === "Runtime.evaluate") return { result: { type: "string", value: "ok" } };
					return {};
				},
				onDetach: { addListener() {} },
			},
		},
	};
	vm.runInNewContext(readBridgeRuntimeFile("cdp.js"), sandbox, { filename: "cdp.js" });
	const cdp = sandbox.self.PiPersistentCdp;
	assert((await cdp.attach(77, { name: "default" })).ok === true, "CDP default attach must succeed");
	assert((await cdp.attach(77, { name: "alias" })).ok === true, "CDP alias attach must reuse an existing physical debugger");
	assert(cdp.sessions.has("77:default"), "CDP default session missing");
	assert(cdp.sessions.has("77:alias"), "CDP alias session missing");
	for (const rec of cdp.sessions.values()) rec.lastUsed = Date.now();
	const release = await cdp.releaseIdle(0);
	assert(release.ok === true, "CDP releaseIdle must accept maxIdleMs:0 as immediate release");
	assert(cdp.sessions.size === 0, "releaseIdle must remove every logical alias entry for the tab");
	assert(detachCount === 1, "releaseIdle must detach the physical debugger after the final alias is removed");

	const evaluated = await cdp.evaluateInFrame(78, "'ok'", { frameId: "main", grantUniversalAccess: true, returnByValue: true });
	assert(evaluated.ok === true, "CDP evaluateInFrame must succeed in Chrome mock");
	const createWorld = sendCalls.find((call) => call.method === "Page.createIsolatedWorld" && call.tabId === 78);
	assert(createWorld?.params.grantUniversalAccess === true, "frame.evaluate must pass grantUniversalAccess to Page.createIsolatedWorld");
	assert(Object.hasOwn(createWorld?.params || {}, "grantUniveralAccess") === false, "frame.evaluate must not send misspelled grantUniveralAccess");
}

await testCdpAliasReleaseAndFrameOptions();

async function testCdpNewDocumentScriptLifecycleContract() {
	const sendCalls = [];
	const notFoundOnRemove = new Set();
	let nextIdentifier = 0;
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		...stateStoreStubs,
		chrome: {
			tabs: { async update() {} },
			debugger: {
				async attach() {},
				async detach() {},
				async sendCommand({ tabId }, method, params) {
					sendCalls.push({ tabId, method, params });
					if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: `script-${++nextIdentifier}` };
					if (method === "Page.removeScriptToEvaluateOnNewDocument") {
						if (notFoundOnRemove.has(params.identifier)) throw new Error("Script not found");
						return {};
					}
					return {};
				},
				onDetach: { addListener() {} },
			},
		},
	};
	vm.runInNewContext(readBridgeRuntimeFile("cdp.js"), sandbox, { filename: "cdp-new-document.js" });
	const cdp = sandbox.self.PiPersistentCdp;
	const added = await cdp.addNewDocumentScript(66, "window.__piNds = 1;", { persistent: true, name: "new_document", runImmediately: true, worldName: "pi_world", includeCommandLineAPI: true });
	assert(added.ok === true && added.data?.identifier === "script-1", "addNewDocumentScript must return the Chrome identifier");
	assert(added.data?.tabId === 66 && added.data?.sessionKey === "66:new_document" && added.data?.cdpSessionName === "new_document", "addNewDocumentScript must return stable tab/session metadata");
	const addCall = sendCalls.find((call) => call.method === "Page.addScriptToEvaluateOnNewDocument");
	assert(addCall?.params.runImmediately === true && addCall?.params.worldName === "pi_world" && addCall?.params.includeCommandLineAPI === true, "addNewDocumentScript must forward runImmediately/worldName/includeCommandLineAPI");

	const removed = await cdp.removeNewDocumentScript(66, added.data.identifier, { persistent: true, name: "new_document" });
	assert(removed.ok === true && removed.data?.identifier === "script-1" && removed.data?.removed === true && removed.data?.alreadyRemoved === false, "removeNewDocumentScript must return a stable normal removal result");
	assert(removed.data?.sessionKey === "66:new_document" && removed.data?.method === "Page.removeScriptToEvaluateOnNewDocument", "removeNewDocumentScript must return sessionKey and method");

	const removeCallCount = sendCalls.filter((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument").length;
	const unknown = await cdp.removeNewDocumentScript(66, "does-not-exist", { persistent: true, name: "new_document" });
	assert(unknown.ok === false && unknown.error?.code === "SCRIPT_NOT_FOUND", "unknown new-document script identifiers must be rejected");
	assert(sendCalls.filter((call) => call.method === "Page.removeScriptToEvaluateOnNewDocument").length === removeCallCount, "unknown identifiers must not be sent to Chrome as idempotent cleanup");

	const addedAgain = await cdp.addNewDocumentScript(66, "window.__piNds = 2;", { persistent: true, name: "new_document" });
	notFoundOnRemove.add(addedAgain.data.identifier);
	const alreadyRemoved = await cdp.removeNewDocumentScript(66, addedAgain.data.identifier, { persistent: true, name: "new_document" });
	assert(alreadyRemoved.ok === true && alreadyRemoved.data?.identifier === addedAgain.data.identifier && alreadyRemoved.data?.removed === false && alreadyRemoved.data?.alreadyRemoved === true, "known identifiers removed by Chrome must return stable alreadyRemoved cleanup");
	assert(alreadyRemoved.data?.sessionKey === "66:new_document" && alreadyRemoved.data?.method === "Page.removeScriptToEvaluateOnNewDocument", "known alreadyRemoved cleanup must preserve stable metadata");
	assert(cdp.newDocumentScripts.size === 0, "new-document script registry must be cleared after normal and alreadyRemoved cleanup");
}

await testCdpNewDocumentScriptLifecycleContract();

async function testFrameCommandStructuredScope() {
	const calls = [];
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { INTERNAL_ERROR: "INTERNAL_ERROR", INVALID_RULE: "INVALID_RULE" },
		piBrowserError(code, error, details) { return { ok: false, error_code: code, error, details }; },
		normalizePersistentPiBrowserResponse: (value) => value,
		piBrowserPersistentCdp: () => ({
			async frameTree(tabId, options) {
				calls.push({ method: "frameTree", tabId, options });
				return { ok: true, data: { frameTree: { frameId: "main", children: [] }, frames: [{ frameId: "main" }, { frameId: "child" }] } };
			},
			async evaluateInFrame(tabId, expression, options) {
				calls.push({ method: "evaluateInFrame", tabId, expression, options });
				return { ok: true, data: { frame: { frameId: options.frameId }, result: { value: 7 } } };
			},
			async addNewDocumentScript(tabId, source, options) {
				calls.push({ method: "addNewDocumentScript", tabId, source, options });
				return { ok: true, data: { identifier: "script-frame-1", sessionKey: `${tabId}:${options.name}`, cdpSessionName: options.name, method: "Page.addScriptToEvaluateOnNewDocument" } };
			},
			async removeNewDocumentScript(tabId, identifier, options) {
				calls.push({ method: "removeNewDocumentScript", tabId, identifier, options });
				return { ok: true, data: { identifier, removed: true, alreadyRemoved: false, sessionKey: `${tabId}:${options.name}`, cdpSessionName: options.name, method: "Page.removeScriptToEvaluateOnNewDocument" } };
			},
		}),
	};
	vm.runInNewContext(`${frameBridge}\nglobalThis.handlePiBrowserFrameCommand = handlePiBrowserFrameCommand;`, sandbox, { filename: "frame.js" });
	const listed = await sandbox.handlePiBrowserFrameCommand("frame.list", 123, { options: { depth: 1 } });
	assert(listed.ok === true && listed.data.tabId === 123 && listed.data.count === 2, "frame.list must return scoped tabId/count metadata");
	const evaluated = await sandbox.handlePiBrowserFrameCommand("frame.evaluate", 123, { frameId: "child", expression: "1+6", grantUniversalAccess: true });
	assert(evaluated.ok === true && evaluated.data.tabId === 123 && evaluated.data.frameId === "child", "frame.evaluate must return scoped tabId/frameId metadata");
	assert(calls.some((call) => call.method === "evaluateInFrame" && call.tabId === 123 && call.options.grantUniversalAccess === true), "frame.evaluate must forward scoped options to CDP");
	const added = await sandbox.handlePiBrowserFrameCommand("frame.addNewDocumentScript", 123, { source: "window.__piNdsCounter=(window.__piNdsCounter||0)+1;", options: { runImmediately: false, worldName: "nested", includeCommandLineAPI: false, timeoutMs: 1 }, runImmediately: true, worldName: "top_world", includeCommandLineAPI: true, timeoutMs: 99 });
	assert(added.ok === true && added.data?.tabId === 123 && added.data?.identifier === "script-frame-1" && added.data?.sessionKey === "123:new_document", "frame.addNewDocumentScript must return stable tab/session identifier metadata");
	const addCall = calls.find((call) => call.method === "addNewDocumentScript");
	assert(addCall?.options.runImmediately === true && addCall?.options.worldName === "top_world" && addCall?.options.includeCommandLineAPI === true && addCall?.options.timeoutMs === 99, "frame.addNewDocumentScript top-level options must override nested options");
	assert(addCall?.options.persistent === true && addCall?.options.name === "new_document", "frame.addNewDocumentScript must keep the persistent new_document CDP session");
	const removed = await sandbox.handlePiBrowserFrameCommand("frame.removeNewDocumentScript", 123, { identifier: "script-frame-1", timeout_ms: 77 });
	assert(removed.ok === true && removed.data?.tabId === 123 && removed.data?.identifier === "script-frame-1" && removed.data?.removed === true && removed.data?.alreadyRemoved === false, "frame.removeNewDocumentScript must return stable removal metadata");
	assert(calls.some((call) => call.method === "removeNewDocumentScript" && call.options.timeoutMs === 77 && call.options.name === "new_document"), "frame.removeNewDocumentScript must forward timeout and session options");
}

await testFrameCommandStructuredScope();

async function testHookReadOnlyScopeContracts() {
	const calls = [];
	const cleanups = [];
	const pageListenerCleanups = [];
	const sessions = new Map([[1, { session_id: "one", state: "INSTALLED" }], [2, { session_id: "two", state: "INSTALLED" }]]);
	const queues = new Map([[1, {}], [2, {}]]);
	const sandbox = {
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", INVALID_SESSION: "INVALID_SESSION", INJECTION_FAILED: "INJECTION_FAILED", NO_SESSION: "NO_SESSION", NOT_INSTALLED: "NOT_INSTALLED", INVALID_SELECTOR: "INVALID_SELECTOR", SELECTOR_NOT_FOUND: "SELECTOR_NOT_FOUND", INTERNAL_ERROR: "INTERNAL_ERROR" },
		PI_BROWSER_HOOK_DISPATCHER_FILE: "hook_dispatcher.js",
		piWithTimeout: async (value) => await value,
		chrome: { scripting: { async executeScript() { return []; } } },
		piBrowserSessions: sessions,
		piBrowserTabQueues: queues,
		getPiBrowserQueueStats: (tabId) => ({ tabId:Number(tabId), pending: false, depth: 0 }),
		piBrowserError(code, error, details) { return { ok: false, error_code: code, error, details }; },
		callPagePiBrowser: async (tabId, command, args, options) => { calls.push({ tabId, command, args, options }); return { ok: true, data: { state: "INSTALLED", command, session_id: args?.session_id } }; },
		callPagePiBrowserWithAutoReinstall: async (tabId, command, args) => { calls.push({ tabId, command, args, autoReinstall: true }); return { ok: true, data: { state: "INSTALLED", command } }; },
		cleanupPiBrowserPageListenersForTab: async (tabId, reason) => { pageListenerCleanups.push({ tabId, reason }); return { ok: true, data: { tabId, removed: 2, listenerIds: ["a", "b"], reason } }; },
		async ensurePiBrowserDispatcher(tabId) { return { ok: true, data: { tabId, method: "test" } }; },
		cleanupWaitsForUninstall(tabId) { cleanups.push({ kind: "waits", tabId }); },
		cleanupPiBrowserTab(tabId, reason) { cleanups.push({ kind: "tab", tabId, reason }); },
		async collectNodeListeners(tabId, msg) { return { ok: true, data: { tabId, selector: msg.selector, node: { tagName: "BUTTON", id: "pay" }, listeners: [{ type: "click", useCapture: false, passive: false, once: false, handler: { url: "fixture.js", line: 12, column: 3, functionName: "onPay" } }], count: 1 } }; },
		async collectNodeListenerChain(tabId, msg) { return { ok: true, data: { tabId, selector: msg.selector, node: { tagName: "BUTTON", id: "pay" }, chain: [{ index: 0, eventType: "click", flags: { capture: false, passive: false, once: false }, handler: { url: "fixture.js", line: 12, column: 3, functionName: "onPay" } }], count: 1 } }; },
		...stateStoreStubs,
	};
	vm.runInNewContext(`${hookBridge}\nglobalThis.handlePiBrowserHookCommand = handlePiBrowserHookCommand;`, sandbox, { filename: "hook.js" });
	const scoped = await sandbox.handlePiBrowserHookCommand("hook.list_sessions", 2, { tabId: 2 });
	assert(scoped.ok === true && scoped.data.count === 1 && scoped.data.sessions[0].tabId === 2, "hook.list_sessions with explicit tabId must only return the target tab session");
	const targets = await sandbox.handlePiBrowserHookCommand("hook.list_targets", 2, {});
	assert(targets.ok === true && targets.data.targets.some((item) => item.id === "domSinks" && item.target === "dom_sinks") && targets.data.rejectedStrategyPresets.includes("stealth"), "hook.list_targets must expose bounded static hook targets and rejected strategy presets");
	const installTargets = await sandbox.handlePiBrowserHookCommand("hook.install_targets", 2, { sessionId: "two", targets: ["console", "dom-sinks", "storage"], buffer_size: 20 });
	assert(installTargets.ok === true && Array.isArray(installTargets.data.expanded_targets) && installTargets.data.expanded_targets.length === 3 && installTargets.data.target_boundary === "static-explicit-targets", "hook.install_targets must return expanded target diagnostics");
	const installCall = calls.find((call) => call.command === "hook.install" && call.args?.targets?.dom_sinks === true && call.args?.targets?.storage === true);
	assert(installCall && installCall.args.session_id === "two", "hook.install_targets must expand ids into hook.install targets and preserve session id");
	const badTarget = await sandbox.handlePiBrowserHookCommand("hook.install_targets", 2, { targets: ["all"] });
	assert(badTarget.ok === false && badTarget.error_code === "INVALID_RULE" && badTarget.details.supported.includes("console"), "hook.install_targets must reject strategy-like or unknown targets with supported ids");
	const nodeListeners = await sandbox.handlePiBrowserHookCommand("hook.getNodeListeners", 2, { selector: "#pay", timeoutMs: 1000 });
	assert(nodeListeners.ok === true && Array.isArray(nodeListeners.data?.listeners), "hook.getNodeListeners must return bounded listener facts for an explicit selector");
	const listenerChain = await sandbox.handlePiBrowserHookCommand("hook.getListenerChain", 2, { selector: "#pay", timeoutMs: 1000 });
	assert(listenerChain.ok === true && Array.isArray(listenerChain.data?.chain), "hook.getListenerChain must return compact node-to-handler chain evidence for an explicit selector");
	await sandbox.handlePiBrowserHookCommand("hook.status", 2, { sessionId: "two", timeoutMs: 777 });
	await sandbox.handlePiBrowserHookCommand("hook.collect", 2, { session_id: "two", limit: 5 });
	await sandbox.handlePiBrowserHookCommand("hook.clear_buffer", 2, { sessionId: "two" });
	await sandbox.handlePiBrowserHookCommand("hook.pause", 2, { session_id: "two" });
	await sandbox.handlePiBrowserHookCommand("hook.resume", 2, { sessionId: "two" });
	const uninstall = await sandbox.handlePiBrowserHookCommand("hook.uninstall", 2, { sessionId: "two" });
	assert(calls.some((call) => call.command === "hook.status" && call.tabId === 2), "hook.status must call the page directly without reinstall side effects");
	assert(calls.some((call) => call.command === "hook.status" && call.options?.timeoutMs === 777), "hook.status must forward timeoutMs to the read-only Runtime.evaluate path");
	assert(calls.some((call) => call.command === "hook.collect" && call.tabId === 2), "hook.collect must call the page directly without reinstall side effects");
	for (const command of ["hook.status", "hook.collect", "hook.clear_buffer", "hook.pause", "hook.resume", "hook.uninstall"]) {
		assert(calls.some((call) => call.command === command && call.args?.session_id === "two"), `${command} must forward explicit sessionId/session_id to the page dispatcher`);
	}
	const listenerCleanupCount = pageListenerCleanups.length;
	const mismatch = await sandbox.handlePiBrowserHookCommand("hook.uninstall", 2, { sessionId: "wrong" });
	assert(mismatch.ok === false && mismatch.error_code === "INVALID_SESSION", "hook.uninstall must reject a mismatched local explicit session before cleanup");
	assert(pageListenerCleanups.length === listenerCleanupCount, "mismatched hook.uninstall must not clean target page listeners");
	assert(cleanups.some((item) => item.kind === "tab" && item.reason === "hook_uninstall"), "successful hook.uninstall must clean local tab state");
	assert(pageListenerCleanups.some((item) => item.tabId === 2 && item.reason === "hook_uninstall"), "hook.uninstall must attempt page listener cleanup");
	assert(uninstall.data?.listener_cleanup?.removed === 2, "hook.uninstall must return page listener cleanup diagnostics");
}

await testHookReadOnlyScopeContracts();

async function testRuntimeCallPagePiBrowserTimeoutContract() {
	const cdpCalls = [];
	const sandbox = {
		PiNativeProtocol: { schema: {}, nativeCommandMap: {}, aliases: {}, canonicalCommand: (cmd) => cmd },
		self: {},
		console,
		setTimeout,
		clearTimeout,
		chrome: { debugger: { async attach() {}, async detach() {}, async sendCommand() { throw new Error("unexpected debugger fallback"); } } },
		piPersistentCdpBridge: {
			async send(tabId, method, params, options) {
				cdpCalls.push({ tabId, method, params, options });
				return { ok: true, data: { result: { result: { value: { ok: true, data: { state: "INSTALLED" } } } } } };
			},
		},
	};
	vm.runInNewContext(`${runtime}\nglobalThis.__runtimeTimeoutTest = { callPagePiBrowser };`, sandbox, { filename: "runtime.js" });
	const result = await sandbox.__runtimeTimeoutTest.callPagePiBrowser(5, "hook.status", {}, { timeoutMs: 3456 });
	assert(result.ok === true && result.data?.state === "INSTALLED", "callPagePiBrowser must return the page dispatcher response");
	assert(cdpCalls.length === 1 && cdpCalls[0].method === "Runtime.evaluate", "callPagePiBrowser must execute through Runtime.evaluate");
	assert(cdpCalls[0].options?.timeoutMs === 3456, "callPagePiBrowser must forward timeoutMs to Runtime.evaluate options");
}

await testRuntimeCallPagePiBrowserTimeoutContract();

async function testPerformanceEntriesAndEvidenceTimeoutContracts() {
	const performanceCalls = [];
	const pagePerformance = {
		getEntriesByType(type) {
			performanceCalls.push({ method: "getEntriesByType", type });
			return type === "resource" ? [{ name: "https://example.test/app.js", entryType: "resource", startTime: 1, duration: 2, initiatorType: "script", transferSize: 10, encodedBodySize: 8, decodedBodySize: 8 }] : [];
		},
		getEntries() {
			performanceCalls.push({ method: "getEntries" });
			return [{ name: "fallback-entry", entryType: "navigation", startTime: 0, duration: 1 }];
		},
	};
	const cdpCalls = [];
	const waitSandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		AbortController,
		PI_BROWSER_ERROR_CODES: { INTERNAL_ERROR: "INTERNAL_ERROR" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserPersistentCdp: () => ({
			async send(tabId, method, params, options) {
				cdpCalls.push({ tabId, method, params, options });
				const value = vm.runInNewContext(params.expression, { performance: pagePerformance }, { filename: "performance-entries-expression.js" });
				return { ok: true, data: { result: { result: { value } } } };
			},
		}),
		normalizePersistentPiBrowserResponse: (value) => value,
	};
	vm.runInNewContext(`${waitBridge}\nglobalThis.__performanceTest = { getPerformanceEntries };`, waitSandbox, { filename: "wait-performance.js" });
	const missing = await waitSandbox.__performanceTest.getPerformanceEntries(7, { entryType: "paint", timeoutMs: 4321 });
	assert(missing.ok === true && missing.data?.count === 0 && missing.data?.explicit_entry_type === true, "explicit missing performance entryType must return count 0");
	assert(performanceCalls.some((call) => call.method === "getEntriesByType" && call.type === "paint"), "performance collection must query the explicit entryType");
	assert(!performanceCalls.some((call) => call.method === "getEntries"), "performance collection must not fall back to performance.getEntries()");
	assert(!cdpCalls[0].params.expression.includes("performance.getEntries()") && !cdpCalls[0].params.expression.includes("byType.length ? byType : all"), "performance expression must not contain the old fallback path");
	assert(cdpCalls[0].options?.timeoutMs === 4321, "getPerformanceEntries must forward timeoutMs to CDP");
	const defaultResource = await waitSandbox.__performanceTest.getPerformanceEntries(7, {});
	assert(defaultResource.ok === true && defaultResource.data?.entryType === "resource" && defaultResource.data?.count === 1 && defaultResource.data?.explicit_entry_type === false, "omitted performance entryType must use the documented resource default");

	const evidenceCalls = [];
	const evidenceSandbox = {
		PI_BROWSER_ERROR_CODES: { INTERNAL_ERROR: "INTERNAL_ERROR", INVALID_RULE: "INVALID_RULE" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		normalizePiBrowserTimeoutMs(msg, fallback) {
			const raw = msg?.timeoutMs ?? msg?.timeout_ms ?? fallback;
			const n = Number(raw);
			return Number.isFinite(n) ? Math.max(0, Math.min(300000, n)) : fallback;
		},
		callPagePiBrowser: async (tabId, command, args, options) => { evidenceCalls.push({ source: "hook", tabId, command, args, options }); return { ok: true, data: { command } }; },
		handleNetworkRecorderCommand: async (tabId, command, args) => { evidenceCalls.push({ source: "network", tabId, command, args }); return { ok: true, data: { command } }; },
		getPerformanceEntries: async (tabId, args) => { evidenceCalls.push({ source: "performance", tabId, args }); return { ok: true, data: { entries: [], count: 0 } }; },
	};
	vm.runInNewContext(`${evidenceBridge}\nglobalThis.__evidenceTimeoutTest = { handlePiBrowserEvidenceCommand };`, evidenceSandbox, { filename: "evidence.js" });
	const evidence = await evidenceSandbox.__evidenceTimeoutTest.handlePiBrowserEvidenceCommand("evidence.collect", 9, { timeoutMs: 2468, entry_type: "paint", name_contains: "api" });
	assert(evidence.ok === true, "evidence.collect fixture must succeed");
	assert(evidenceCalls.some((call) => call.command === "hook.status" && call.options?.timeoutMs === 2468), "evidence hook_status must forward top-level timeoutMs to callPagePiBrowser");
	assert(evidenceCalls.some((call) => call.command === "hook.collect" && call.options?.timeoutMs === 2468 && call.args?.timeout_ms === 2468), "evidence hook.collect must forward timeoutMs to dispatcher args and Runtime.evaluate options");
	assert(evidenceCalls.some((call) => call.source === "performance" && call.args?.timeoutMs === 2468 && call.args?.entryType === "paint" && call.args?.nameContains === "api"), "evidence performance source must forward timeout, entryType and nameContains");
}

await testPerformanceEntriesAndEvidenceTimeoutContracts();

async function testHookEventListenerTabScopeAndCleanupContracts() {
	function createPage() {
		const listeners = [];
		const document = {
			addEventListener(type, handler, capture) { listeners.push({ type, handler, capture }); },
			removeEventListener(type, handler, capture) {
				const index = listeners.findIndex((item) => item.type === type && item.handler === handler && item.capture === capture);
				if (index >= 0) listeners.splice(index, 1);
			},
			querySelector(selector) { return selector === "#target" ? this : null; },
			listenerCount() { return listeners.length; },
		};
		const pageWindow = { __piBrowserListeners: undefined };
		return { sandbox: { window: pageWindow, document, Date }, window: pageWindow, document };
	}
	const pages = new Map([[1, createPage()], [2, createPage()]]);
	const cdpCalls = [];
	const cdp = {
		async send(tabId, method, params, options) {
			cdpCalls.push({ tabId, method, options });
			const page = pages.get(Number(tabId));
			assert(page, "test page context must exist for the requested tab");
			const value = vm.runInNewContext(params.expression, page.sandbox, { filename: `page-${tabId}.js` });
			return { ok: true, data: { result: { result: { value } } } };
		},
	};
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		Date,
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", EVENT_SUBSCRIPTION_FAILED: "EVENT_SUBSCRIPTION_FAILED" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserPersistentCdp: () => cdp,
		normalizePersistentPiBrowserResponse: (value) => value,
	};
	vm.runInNewContext(`${waitBridge}
globalThis.__listenerScopeTest = {
	addEventListener,
	removeEventListener,
	cleanupPiBrowserPageListenersForTab,
	cleanupEventSubscriptionsForTab,
	cleanupWaitsForUninstall,
	subscriptions: () => Array.from(piBrowserWaits.eventSubscriptionValues()).map(s => ({ key:s.key, tabId:s.tabId, listenerId:s.listenerId, eventType:s.eventType }))
};`, sandbox, { filename: "wait-listener-scope.js" });
	const api = sandbox.__listenerScopeTest;
	const addTab1 = await api.addEventListener(1, { listenerId: "dup-listener", eventType: "click" });
	const addTab2 = await api.addEventListener(2, { listenerId: "dup-listener", eventType: "click" });
	assert(addTab1.ok === true && addTab2.ok === true, "same listenerId must be accepted on different tabs");
	assert(api.subscriptions().length === 2, "event listener registry must keep two tab-scoped subscriptions for duplicate listenerId values");
	assert(api.subscriptions().some((item) => item.key === "1::dup-listener") && api.subscriptions().some((item) => item.key === "2::dup-listener"), "event listener registry keys must include tabId scope");
	assert(pages.get(1).document.listenerCount() === 1 && pages.get(2).document.listenerCount() === 1, "page listener stores must contain one DOM listener per tab");

	const removeTab1 = await api.removeEventListener(1, { listenerId: "dup-listener" });
	assert(removeTab1.ok === true && removeTab1.data?.tabId === 1 && removeTab1.data?.registry_removed === true && removeTab1.data?.page_removed === true, "hook.removeEventListener must remove only the target tab listener");
	assert(api.subscriptions().length === 1 && api.subscriptions()[0].tabId === 2, "removing one tab listener must not remove another tab's same listenerId registry entry");
	assert(!pages.get(1).window.__piBrowserListeners?.["dup-listener"] && pages.get(1).document.listenerCount() === 0, "target tab page listener store must be empty after remove");
	assert(pages.get(2).window.__piBrowserListeners?.["dup-listener"] && pages.get(2).document.listenerCount() === 1, "other tab page listener must remain installed after same-id remove on target tab");

	const removeTab1Again = await api.removeEventListener(1, { listenerId: "dup-listener" });
	assert(removeTab1Again.ok === true && removeTab1Again.data?.registry_removed === false && removeTab1Again.data?.page_removed === false, "removing a same listenerId from a tab without that listener must not affect another tab");
	assert(api.subscriptions().length === 1 && api.subscriptions()[0].tabId === 2, "same-id listener on another tab must survive a no-op remove");

	const pageCleanup = await api.cleanupPiBrowserPageListenersForTab(2, "contract_cleanup");
	assert(pageCleanup.ok === true && pageCleanup.data?.removed === 1 && !pages.get(2).window.__piBrowserListeners?.["dup-listener"] && pages.get(2).document.listenerCount() === 0, "page listener cleanup must remove DOM listener and page store entries");
	assert(api.cleanupEventSubscriptionsForTab(2) === 1 && api.subscriptions().length === 0, "tab cleanup must remove only the target tab's registry entries");

	await api.addEventListener(1, { listenerId: "after-cleanup", eventType: "click" });
	const pageCleanup2 = await api.cleanupPiBrowserPageListenersForTab(1, "hook_uninstall");
	const registryCleanup = api.cleanupWaitsForUninstall(1);
	assert(pageCleanup2.data?.removed === 1 && registryCleanup === 0 && api.subscriptions().length === 0, "uninstall cleanup must leave page store and registry empty");
	assert(cdpCalls.some((call) => call.options?.name === "event_listener_cleanup"), "cleanup must execute a page-side listener removal script through CDP");
}

await testHookEventListenerTabScopeAndCleanupContracts();

async function testWaitCoordinatorCleanupContracts() {
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		AbortController,
		PI_BROWSER_ERROR_CODES: { TIMEOUT: "TIMEOUT", INTERNAL_ERROR: "INTERNAL_ERROR", CANCELLED: "CANCELLED" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
	};
	vm.runInNewContext(`${waitBridge}
globalThis.__waitCoordinatorTest = {
	registerWait,
	cleanupPiBrowserOrphanWaits,
	cleanupTabWaits,
	cancelWaitsForTab,
	waitKey,
	hasWait: (tabId, waitId) => piBrowserWaits.has(waitKey(tabId, waitId)),
	waits: () => Array.from(piBrowserWaits.values()).map((wait) => ({ tabId:wait.tabId, waitId:wait.waitId, kind:wait.kind, status:wait.status }))
};`, sandbox, { filename: "wait-coordinator-contract.js" });
	const api = sandbox.__waitCoordinatorTest;
	const oldWait = api.registerWait(31, "orphan", { waitId: "old-orphan" });
	const youngWait = api.registerWait(31, "young", { waitId: "young-live" });
	oldWait.createdAt = Date.now() - 10000;
	youngWait.createdAt = Date.now();
	const orphanCleaned = api.cleanupPiBrowserOrphanWaits("contract_orphan", 1000);
	assert(orphanCleaned === 1 && !api.hasWait(31, "old-orphan") && api.hasWait(31, "young-live"), "orphan cleanup must remove only waits older than the configured age");

	api.registerWait(32, "cancel-a", { waitId: "cancel-a" });
	api.registerWait(32, "cancel-b", { waitId: "cancel-b" });
	const cancelled = api.cancelWaitsForTab(32, "tab_cleanup");
	assert(cancelled === 2 && !api.hasWait(32, "cancel-a") && !api.hasWait(32, "cancel-b"), "cancelWaitsForTab(tabId,'tab_cleanup') must clean all waits for the target tab");

	api.registerWait(33, "cleanup-tab", { waitId: "cleanup-tab" });
	const cleanup = api.cleanupTabWaits(33, "tab_cleanup", { includeCdp: false, remember: false });
	assert(cleanup.cleaned === 1 && cleanup.aborted === 1 && cleanup.orphaned === 0 && !api.hasWait(33, "cleanup-tab"), "cleanupTabWaits must abort and remove the target tab wait record");
}

await testWaitCoordinatorCleanupContracts();

async function testWaitDiagnoseIframeProbeContract() {
	function iframe(attrs, rect, style) {
		return {
			id: attrs.id || "",
			name: attrs.name || "",
			src: attrs.src || "",
			title: attrs.title || "",
			loading: attrs.loading || "",
			getAttribute(name) { return attrs[name] ?? ""; },
			getBoundingClientRect() { return rect; },
			__style: style,
		};
	}
	const iframes = [
		iframe({ id: "login-frame", name: "login", src: "https://example.test/login", title: "Login" }, { x: 10, y: 20, top: 20, left: 10, right: 210, bottom: 120, width: 200, height: 100 }, { display: "block", visibility: "visible", opacity: "1" }),
		iframe({ id: "hidden-frame", name: "hidden", src: "about:blank" }, { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }, { display: "none", visibility: "hidden", opacity: "0" }),
	];
	const pageSandbox = {
		window: {
			frames: { length: 2 },
			__piBrowserInflight: 4,
			__piBrowserLastErrors: ["fixture-page-error"],
			getComputedStyle(node) { return node.__style || {}; },
		},
		document: {
			readyState: "complete",
			querySelectorAll(selector) {
				assert(selector === "iframe", "wait.diagnose must query iframe elements");
				return iframes;
			},
		},
	};
	const evaluateCalls = [];
	const sessions = new Map([[31, { session_id: "diagnose-session", state: "INSTALLED" }], [32, { session_id: "other-session", state: "INSTALLED" }]]);
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		AbortController,
		Date,
		PI_BROWSER_ERROR_CODES: { NO_SESSION: "NO_SESSION", INTERNAL_ERROR: "INTERNAL_ERROR" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserSessions: sessions,
		getPiBrowserQueueStats: (tabId) => ({ tabId:Number(tabId), pending: false, depth: 0 }),
		callPagePiBrowser: async (tabId, command, args) => {
			assert(tabId === 31, "wait.diagnose must call the requested tab");
			if (command === "hook.status") return { ok: true, data: { session_id: "diagnose-session", state: "INSTALLED", dispatcher_version: "hook-test", installed_at: "2026-05-20T00:00:00.000Z", install_epoch: 123 } };
			if (command === "hook.evaluate") {
				evaluateCalls.push(args.expression);
				assert(args.expression.includes("document.frames") === false, "diagnose evaluate expression must not reference document.frames");
				const result = vm.runInNewContext(args.expression, pageSandbox, { filename: "diagnose-iframe-expression.js" });
				return { ok: true, data: { result, type: "object" } };
			}
			throw new Error(`unexpected command: ${command}`);
		},
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		chrome: {
			tabs: { async get(tabId) { return { id: tabId, url: "https://example.test", title: "Diagnose", status: "complete" }; } },
			debugger: { async getTargets() { return [{ tabId: 31, type: "page" }, { tabId: 32, type: "page" }]; } },
		},
	};
	vm.runInNewContext(`${waitBridge}\nself.__diagnoseIframeTest = { diagnosePiBrowser };`, sandbox, { filename: "wait-diagnose-iframe.js" });
	const result = await sandbox.self.__diagnoseIframeTest.diagnosePiBrowser(31, { cmd: "wait.diagnose" });
	assert(result.ok === true, "wait.diagnose iframe fixture must succeed");
	assert(evaluateCalls.length === 1, "wait.diagnose must run one page probe");
	assert(result.data.frameCount === 2, "wait.diagnose must expose window.frames.length as frameCount");
	assert(result.data.iframeCount === 2, "wait.diagnose must expose iframe element count");
	assert(result.data.frames.length === 2, "wait.diagnose must return iframe node diagnostics");
	assert(result.data.frames[0].id === "login-frame", "wait.diagnose iframe diagnostics must include iframe id");
	assert(result.data.frames[0].name === "login", "wait.diagnose iframe diagnostics must include iframe name");
	assert(result.data.frames[0].src === "https://example.test/login", "wait.diagnose iframe diagnostics must include iframe src");
	assert(result.data.frames[0].visible === true, "wait.diagnose iframe diagnostics must include visibility");
	assert(result.data.frames[0].rect.width === 200, "wait.diagnose iframe diagnostics must include geometry");
	assert(result.data.frames[1].visible === false, "wait.diagnose must report hidden iframes as not visible");
	assert(result.data.debuggerTargets.length === 1, "wait.diagnose debugger targets must stay scoped to the requested tab");
	assert(result.data.inflight === 4, "wait.diagnose must retain page inflight diagnostics");
	assert(result.data.last_errors.includes("fixture-page-error"), "wait.diagnose must retain page last_errors diagnostics");
}

await testWaitDiagnoseIframeProbeContract();

async function testWaitNavigationImmediateCheckUsesCurrentState() {
	let currentTab = { id: 7, url: "https://example.test/start", title: "Start", status: "complete" };
	let currentMetrics = { url: currentTab.url, title: currentTab.title, readyState: "complete", domContentLoaded: true, load: true };
	let listenerCount = 0;
	const eventTarget = { addListener() { listenerCount += 1; }, removeListener() {} };
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		AbortController,
		PI_BROWSER_ERROR_CODES: { TIMEOUT: "TIMEOUT", NAVIGATION_TIMEOUT: "NAVIGATION_TIMEOUT", INVALID_RULE: "INVALID_RULE", INTERNAL_ERROR: "INTERNAL_ERROR", CANCELLED: "CANCELLED" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserEval: async () => ({ ok: true, data: currentMetrics }),
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
		chrome: {
			tabs: {
				async get(tabId) { assert(tabId === 7, "wait.navigation immediate check must inspect the requested tab"); return currentTab; },
				onUpdated: eventTarget,
			},
			webNavigation: {
				onBeforeNavigate: eventTarget, onCommitted: eventTarget, onCompleted: eventTarget, onErrorOccurred: eventTarget, onHistoryStateUpdated: eventTarget, onReferenceFragmentUpdated: eventTarget,
			},
			debugger: { onEvent: eventTarget, onDetach: eventTarget },
		},
	};
	vm.runInNewContext(`${waitBridge}\nself.__waitNavigationTest = { waitForNavigation };`, sandbox, { filename: "wait.js" });
	const miss = await sandbox.self.__waitNavigationTest.waitForNavigation(7, { cmd: "wait.navigation", targetUrl: "https://example.test/next", timeoutMs: 0 });
	assert(miss.ok === false && miss.error_code === "TIMEOUT", "wait.navigation timeoutMs:0 must fail when the current URL does not match");
	assert(/immediate check failed/.test(miss.error), "wait.navigation immediate miss must expose a clear error");
	assert(miss.details?.timeout_ms === 0 && miss.details?.reason === "url_mismatch", "wait.navigation immediate miss must expose immediate diagnostics");
	assert(listenerCount === 0, "wait.navigation immediate check must not install async navigation listeners");
	currentTab = { id: 7, url: "https://example.test/next", title: "Next", status: "complete" };
	currentMetrics = { url: currentTab.url, title: currentTab.title, readyState: "complete", domContentLoaded: true, load: true };
	const hit = await sandbox.self.__waitNavigationTest.waitForNavigation(7, { cmd: "wait.navigation", targetUrl: "https://example.test/next", waitUntil: "load", timeoutMs: 0 });
	assert(hit.ok === true && hit.data?.immediate === true, "wait.navigation timeoutMs:0 must succeed when current URL and load state already match");
	assert(hit.data?.stage === "complete" && hit.data?.url === "https://example.test/next", "wait.navigation immediate hit must report the matched current navigation state");
}

await testWaitNavigationImmediateCheckUsesCurrentState();

async function testWaitAllRejectsEmptyConditions() {
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		AbortController,
		PI_BROWSER_ERROR_CODES: { INVALID_RULE: "INVALID_RULE", CANCELLED: "CANCELLED", INTERNAL_ERROR: "INTERNAL_ERROR", TIMEOUT: "TIMEOUT", NAVIGATION_TIMEOUT: "NAVIGATION_TIMEOUT" },
		piBrowserError: (error_code, error, details) => ({ ok: false, error_code, error, details }),
		piBrowserEval: async () => ({ ok: true, data: { readyState: "complete", url: "https://example.test/ready", title: "Ready", domContentLoaded: true, load: true } }),
		chrome: {
			tabs: { async get() { return { id: 7, url: "https://example.test/ready", title: "Ready", status: "complete" }; } },
			debugger: { onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
		},
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
	};
	vm.runInNewContext(`${waitBridge}\nself.__waitCompositeTest = { waitForAll, waitForAny };`, sandbox, { filename: "wait.js" });
	const allResult = await sandbox.self.__waitCompositeTest.waitForAll(7, { cmd: "wait.all", waits: [] });
	assert(allResult.ok === false && allResult.error_code === "INVALID_RULE" && /wait\.all requires waits\/conditions/.test(allResult.error), "wait.all must reject an empty waits array");
	const anyResult = await sandbox.self.__waitCompositeTest.waitForAny(7, { cmd: "wait.any", waits: [] });
	assert(anyResult.ok === false && anyResult.error_code === "INVALID_RULE" && /wait\.any requires waits\/conditions/.test(anyResult.error), "wait.any empty-input contract must remain aligned");
	const allStandardCommand = await sandbox.self.__waitCompositeTest.waitForAll(7, { cmd: "wait.all", waits: [{ cmd: "wait.loadState", state: "complete", timeoutMs: 0 }] });
	assert(allStandardCommand.ok === true && allStandardCommand.data?.matched === 1, "wait.all child must accept full native command names such as wait.loadState");
	const anyStandardCommand = await sandbox.self.__waitCompositeTest.waitForAny(7, { cmd: "wait.any", waits: [{ cmd: "wait.loadState", state: "complete", timeoutMs: 0 }], timeoutMs: 1000 });
	assert(anyStandardCommand.ok === true && anyStandardCommand.data?.winner === 0, "wait.any child must accept full native command names such as wait.loadState");
}

await testWaitAllRejectsEmptyConditions();

async function testWaitCdpDisableFailureKeepsDomainRef() {
	const sendCalls = [];
	const debugListeners = new Set();
	let failDisable = true;
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
		AbortController,
		chrome: {
			debugger: {
				async attach() {},
				async sendCommand({ tabId }, method) {
					sendCalls.push({ tabId, method });
					if (method === "Network.disable" && failDisable) throw new Error("disable boom");
					return {};
				},
				onEvent: {
					addListener(listener) { debugListeners.add(listener); },
					removeListener(listener) { debugListeners.delete(listener); },
				},
			},
		},
		piBrowserPersistentCdp: () => null,
		normalizePersistentPiBrowserResponse: (value) => value,
	};
	vm.runInNewContext(`${waitBridge}
self.__waitCdpTest = { acquirePiBrowserCdpDomain, releasePiBrowserCdpDomains, forceReleasePiBrowserCdpDomainsForTab, subscribePiBrowserCdp, cleanupPiBrowserCdpTab, diagnosePiBrowserCdpSubscriptions, diagnosePiBrowserCdpDomainRefs };`, sandbox, { filename: "wait.js" });
	const first = { tabId: 88, waitId: "first", kind: "contract", cdpDomains: new Set(), cdpSubscriptions: [] };
	await sandbox.self.__waitCdpTest.acquirePiBrowserCdpDomain(first, "Network");
	sandbox.self.__waitCdpTest.releasePiBrowserCdpDomains(first, ["Network"], "contract_release");
	await new Promise((resolve) => setTimeout(resolve, 0));
	let refs = sandbox.self.__waitCdpTest.diagnosePiBrowserCdpDomainRefs(88);
	assert(refs.length === 1, "failed CDP disable must keep the domain ref for retry");
	assert(refs[0].disablePending === true, "failed CDP disable must mark disablePending");
	assert(/disable boom/.test(refs[0].lastError || ""), "failed CDP disable must preserve lastError diagnostics");

	failDisable = false;
	const second = { tabId: 88, waitId: "second", kind: "contract", cdpDomains: new Set(), cdpSubscriptions: [] };
	await sandbox.self.__waitCdpTest.acquirePiBrowserCdpDomain(second, "Network");
	refs = sandbox.self.__waitCdpTest.diagnosePiBrowserCdpDomainRefs(88);
	assert(refs.length === 1 && refs[0].count === 1 && refs[0].disablePending === false, "new acquire must reuse and reactivate retained CDP ref");
	sandbox.self.__waitCdpTest.releasePiBrowserCdpDomains(second, ["Network"], "contract_retry_release");
	await new Promise((resolve) => setTimeout(resolve, 0));
	refs = sandbox.self.__waitCdpTest.diagnosePiBrowserCdpDomainRefs(88);
	assert(refs.length === 0, "successful retry disable must remove the retained CDP ref");
	assert(sendCalls.some((call) => call.method === "Network.disable"), "CDP disable must be attempted");

	failDisable = true;
	const removed = { tabId: 89, waitId: "removed", kind: "contract", cdpDomains: new Set(), cdpSubscriptions: [] };
	await sandbox.self.__waitCdpTest.acquirePiBrowserCdpDomain(removed, "Network");
	sandbox.self.__waitCdpTest.forceReleasePiBrowserCdpDomainsForTab(89, "tab_removed");
	await new Promise((resolve) => setTimeout(resolve, 0));
	refs = sandbox.self.__waitCdpTest.diagnosePiBrowserCdpDomainRefs(89);
	assert(refs.length === 0, "tab_removed force cleanup must not retain stale CDP refs when the tab is already gone");

	let delivered = 0;
	const subRecord = { tabId: 90, waitId: "subscriber", kind: "contract", cdpDomains: new Set(), cdpSubscriptions: [] };
	const subId = sandbox.self.__waitCdpTest.subscribePiBrowserCdp(90, ["Network.responseReceived"], () => { delivered += 1; }, subRecord);
	assert(subId && subRecord.cdpSubscriptions.includes(subId), "CDP subscriber id must be registered on the wait record");
	assert(sandbox.self.__waitCdpTest.diagnosePiBrowserCdpSubscriptions(90).length === 1, "CDP subscriber diagnostics must show active subscription");
	for (const listener of Array.from(debugListeners)) listener({ tabId: 90 }, "Network.responseReceived", {});
	assert(delivered === 1, "CDP subscriber must dispatch matching events before cleanup");
	const cleanup = sandbox.self.__waitCdpTest.cleanupPiBrowserCdpTab(90, "subscriber_cleanup");
	assert(cleanup.subscriptions_removed === 1 && debugListeners.size === 0, "CDP tab cleanup must remove subscriber listener handles");
	assert(sandbox.self.__waitCdpTest.diagnosePiBrowserCdpSubscriptions(90).length === 0, "CDP subscriber diagnostics must be empty after tab cleanup");
}

await testWaitCdpDisableFailureKeepsDomainRef();

console.log("pi browser bridge contract ok");
