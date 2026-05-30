import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bridge = path.join(root, "bridge", "pi_browser_bridge");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
function assert(condition, message) { if (!condition) throw new Error(message); }
function assertBackgroundOrder(background, files, message) {
	for (let i = 1; i < files.length; i += 1) {
		assert(background.indexOf(files[i - 1]) < background.indexOf(files[i]), `${message}: ${files[i - 1]} must load before ${files[i]}`);
	}
}

const waitBridgeRuntimeFiles = ["wait_cdp.js", "wait_coordinator.js", "wait_navigation.js", "wait_network_idle.js", "wait_selector.js", "wait.js"];
const networkBridgeRuntimeFiles = ["network_model.js", "network_events.js", "network.js"];
const serviceWorkerBridgeFiles = ["config.js", "protocol.js", "patterns.js", "cdp.js", "state_store.js", "runtime.js", ...waitBridgeRuntimeFiles, ...networkBridgeRuntimeFiles, "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "ws_model.js", "ws.js", "router.js", "tab_sync.js", "transport.js"];
function stripBridgeSource(text) {
	return text
		.replace(/^\/\/ @ts-nocheck\r?\n/, "")
		.replace(/^import\s+[^;]+;\r?\n/gm, "")
		.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
		.replace(/^export async function /gm, "async function ")
		.replace(/^export function /gm, "function ")
		.replace(/^export class /gm, "class ")
		.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
		.replace(/\s+as\s+any/g, "")
		.replace(/\r?\n\/\/ ESM module (?:boundary marker(?: for TODO 189)?|metadata)\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
		.replace(/^export const __piBridgeModule_[\s\S]*?;\s*$/gm, "")
		.replace(/\r?\nexport \{\};\s*$/, "");
}
function executableBridgeSource(text, sourcefile) {
	return transformSync(text, { loader: "ts", target: "chrome120", sourcefile }).code;
}
function readServiceWorkerSource(file) {
	return stripBridgeSource(read(`bridge_src/service_worker/${file.replace(/\.js$/, "")}.ts`));
}
function readPageSource(file) {
	return stripBridgeSource(read(`bridge_src/page_scripts/${file.replace(/\.js$/, "")}.ts`).replace(/\r?\nexport \{\};\s*$/, ""));
}
const background = serviceWorkerBridgeFiles.join(" ");

const requiredBridgeFiles = [
	"manifest.json", "popup.html", "popup.js", "native_command_schema.json", "dist/.gitignore",
];
for (const file of requiredBridgeFiles) assert(existsSync(path.join(bridge, file)), `missing bridge file: ${file}`);
for (const file of serviceWorkerBridgeFiles) assert(existsSync(path.join(root, "bridge_src", "service_worker", `${file.replace(/\.js$/, "")}.ts`)), `missing service worker source: ${file}`);
for (const file of ["content.js", "hook_dispatcher.js", "disable_dialogs.js"]) assert(existsSync(path.join(root, "bridge_src", "page_scripts", `${file.replace(/\.js$/, "")}.ts`)), `missing page script source: ${file}`);

const pkg = JSON.parse(read("package.json"));
assert(pkg.version === "0.3.0", "package version must be 0.3.0");
assert(pkg.keywords?.includes("pi-package"), "package must declare pi-package keyword");
assert(pkg.pi?.extensions?.includes("./index.ts"), "package pi manifest must expose index.ts");
assert(pkg.scripts?.["sync:protocol"] === "node scripts/sync-native-protocol.mjs", "package must expose protocol sync script");
assert(pkg.scripts?.["sync:config"] === "node scripts/sync-bridge-config.mjs", "package must expose bridge config sync script");
assert(String(pkg.scripts?.["check:bridge:types"] || "").includes("tsconfig.bridge-src.json"), "bridge type checks must include the ESM TypeScript source graph");
assert(!String(pkg.scripts?.["check:bridge:types"] || "").includes("tsconfig.bridge.json"), "bridge type checks must not depend on deleted legacy JS ambient globals");
assert(String(pkg.scripts?.["check:bridge"] || "").includes("check:bridge:types"), "bridge checks must include bridge checkJs/typecheck");
assert(pkg.scripts?.["verify:bridge:dist"] === "node tests/contracts/check-bridge-build.mjs", "package must expose a read-only bridge dist verification command");
assert(pkg.scripts?.["check:bridge:build"] === "npm run verify:bridge:dist", "bridge checks must verify current dist instead of rebuilding it");
assert(String(pkg.scripts?.["check:bridge"] || "").indexOf("check:bridge:build") < String(pkg.scripts?.["check:bridge"] || "").indexOf("check:bridge:files"), "bridge checks must verify dist before file contracts read manifest/dist output");
assert(pkg.devDependencies?.typescript, "package must depend on TypeScript for bridge checkJs typecheck");
const bridgeSrcTsconfig = JSON.parse(read("tsconfig.bridge-src.json"));
assert(bridgeSrcTsconfig.include?.includes("bridge_src/**/*.ts"), "bridge source tsconfig must cover bridge_src TypeScript modules");
assert(bridgeSrcTsconfig.compilerOptions?.strict === true && bridgeSrcTsconfig.compilerOptions?.noImplicitAny === true, "TODO 200 bridge tsconfig must enable strict and noImplicitAny");
assert(!existsSync(path.join(bridge, "bridge-globals.d.ts")), "legacy bridge ambient globals must be removed after manifest switches to dist");
for (const sourcePath of [
	...serviceWorkerBridgeFiles.map((file) => `bridge_src/service_worker/${file.replace(/\.js$/, "")}.ts`),
	...['content', 'hook_dispatcher', 'disable_dialogs'].map((file) => `bridge_src/page_scripts/${file}.ts`),
	'tsconfig.bridge-src.json',
]) {
	const raw = read(sourcePath);
	assert(!raw.includes('@ts-nocheck'), `TODO 200 source must not use @ts-nocheck: ${sourcePath}`);
	assert(!raw.includes('Record<string, any>'), `TODO 200 source must not use broad Record<string, any>: ${sourcePath}`);
	assert(!/\bas\s+any\b/.test(raw), `TODO 200 source must not use broad as any casts: ${sourcePath}`);
}
const runtimeEnvSource = read('bridge_src/service_worker/runtimeEnv.ts');

const manifest = JSON.parse(read("bridge/pi_browser_bridge/manifest.json"));
assert(manifest.name === "Pi Native Browser Bridge", "manifest name must be Pi Native Browser Bridge");
assert(manifest.version === "0.3.0", "manifest version must be 0.3.0");
assert(manifest.background?.service_worker === "dist/service-worker.js" && manifest.background?.type === "module", "manifest must use the generated dist module service worker");
assert(JSON.stringify(manifest.content_scripts?.[0]?.js) === JSON.stringify(["dist/disable_dialogs.js"]), "manifest document_start script must use dist disable-dialogs bundle");
assert(JSON.stringify(manifest.content_scripts?.[1]?.js) === JSON.stringify(["dist/content.js"]), "manifest document_idle script must use dist content bundle");
assert(manifest.permissions?.includes("downloads"), "manifest must declare downloads permission for browser_download path return");

const bridgeInfo = readServiceWorkerSource("bridge_info.js");
const transport = readServiceWorkerSource("transport.js");
const router = readServiceWorkerSource("router.js");
const runtimeBridge = readServiceWorkerSource("runtime.js");
const hookBridge = readServiceWorkerSource("hook.js");
const hookDispatcher = readPageSource("hook_dispatcher.js");
const waitCdp = readServiceWorkerSource("wait_cdp.js");
const waitCoordinator = readServiceWorkerSource("wait_coordinator.js");
const waitNavigation = readServiceWorkerSource("wait_navigation.js");
const waitNetworkIdle = readServiceWorkerSource("wait_network_idle.js");
const waitSelector = readServiceWorkerSource("wait_selector.js");
const waitRuntime = readServiceWorkerSource("wait.js");
const networkModel = readServiceWorkerSource("network_model.js");
const networkRuntime = readServiceWorkerSource("network.js");
const foundationModuleNames = ["config", "protocol", "patterns", "cdp", "state_store", "runtime", "wait_cdp", "wait_coordinator", "wait_navigation", "wait_network_idle", "wait_selector", "wait"];
for (const foundation of foundationModuleNames) {
	const raw = read(`bridge_src/service_worker/${foundation}.ts`);
	assert(!raw.includes("@ts-nocheck"), `TODO 197 foundation source must not use @ts-nocheck: ${foundation}`);
	assert(raw.includes(`export const __piBridgeModule_${foundation}`), `TODO 197 foundation source must export its module symbol: ${foundation}`);
}
const runtimeSourceRaw = read("bridge_src/service_worker/runtime.ts");
assert(runtimeSourceRaw.includes("from \"./network\"") && runtimeSourceRaw.includes("handleNetworkRecorderCommand") && runtimeSourceRaw.includes("from \"./hook\"") && runtimeSourceRaw.includes("handlePiBrowserHookCommand") && runtimeSourceRaw.includes("from \"./ws\"") && runtimeSourceRaw.includes("handlePiBrowserWsCommand"), "runtime must route TODO 198 command handlers through ESM imports");
for (const legacyHandler of ["handleNetworkRecorderCommand", "handlePiBrowserHookCommand", "handlePiBrowserEvidenceCommand", "handlePiBrowserFrameCommand", "handlePiBrowserTransferCommand", "handlePiBrowserHtml", "captureScreenshotWithRetry"]) {
	assert(!runtimeSourceRaw.includes(`requireLegacyCommand('${legacyHandler}')`), `runtime must not route command handler through legacy global: ${legacyHandler}`);
}
assert(router.includes("@param {PiBridgeCommand}") && router.includes("@param {PiBridgeWebSocketLike}"), "router must document bridge envelope/socket JSDoc types");
assert(router.includes("@param {PiBridgeWsEnvelope}") && runtimeEnvSource.includes("serviceWorkerGlobal") && runtimeEnvSource.includes("ChromeApi"), "bridge runtime/router must consume tightened ambient boundary types");
assert(bridgeInfo.includes("manifest.version_name || manifest.version"), "bridge_info must report display version_name when available");
for (const file of serviceWorkerBridgeFiles) assert(background.includes(file), `background.js must import ${file}`);
assertBackgroundOrder(background, serviceWorkerBridgeFiles, "background service worker script order");
assert(background.indexOf("protocol.js") < background.indexOf("runtime.js"), "background.js must load protocol.js before runtime.js");
assert(background.indexOf("protocol.js") < background.indexOf("router.js"), "background.js must load protocol.js before router.js");
assert(background.indexOf("router.js") < background.indexOf("transport.js"), "background.js must load router.js before transport.js");
assert(background.indexOf("tab_sync.js") < background.indexOf("transport.js"), "background.js must load tab_sync.js before transport.js");
assert(!background.includes("hook_dispatcher.js"), "hook_dispatcher.js must stay out of the service worker importScripts graph");
assert(runtimeBridge.includes("const PI_BROWSER_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js';"), "runtime.js must own the generated hook dispatcher filename during dist runtime");
assert(runtimeBridge.includes("window.__PI_BROWSER_HOOKS__ && window.__PI_BROWSER_HOOKS__.dispatch"), "runtime page calls must dispatch through the stable hook page global");
assert(hookBridge.includes("chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PI_BROWSER_HOOK_DISPATCHER_FILE] })"), "hook.js must inject the dispatcher through the stable file constant");
assert(hookBridge.includes("fetch(chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE))"), "hook.js CDP fallback must fetch the same dispatcher file constant");
assert(hookDispatcher.includes(";(function PiBrowserHookDispatcher()") && hookDispatcher.includes("__PI_BROWSER_HOOKS__ = {"), "hook_dispatcher.ts must remain a self-contained page IIFE exposing window.__PI_BROWSER_HOOKS__");
assert(!/\bimport\s+|\bimport\s*\(|\bexport\s+|importScripts\s*\(/.test(hookDispatcher), "hook_dispatcher.ts must remain self-contained page script source");
assert(!/chrome\./.test(hookDispatcher), "hook_dispatcher.js must not call Chrome extension APIs from the page MAIN world");
assert(waitBridgeRuntimeFiles.at(-1) === "wait.js", "wait bridge runtime bundle must keep wait.js as the final facade/dispatch script");
assert(waitBridgeRuntimeFiles[0] === "wait_cdp.js" && waitBridgeRuntimeFiles[1] === "wait_coordinator.js" && waitBridgeRuntimeFiles.at(-1) === "wait.js", "wait helper modules must load before final wait.js facade");
assert(/const\s+piBrowserCdpDomainRefs\s*=\s*new Map/.test(waitCdp) && waitCdp.includes("function acquirePiBrowserCdpDomain") && waitCdp.includes("function subscribePiBrowserCdp") && waitCdp.includes("function diagnosePiBrowserCdpCleanupHistory"), "wait_cdp.js must own CDP refcount/subscription/cleanup diagnostics helpers");
assert(waitCoordinator.includes("class WaitCoordinator") && /const\s+piBrowserWaits\s*=\s*new WaitCoordinator/.test(waitCoordinator) && waitCoordinator.includes("function cleanupPiBrowserOrphanWaits") && waitCoordinator.includes("function cleanupEventSubscriptionsForTab"), "wait_coordinator.js must own wait registry, orphan cleanup, and event subscription helpers");
assert(waitNavigation.includes("async function waitForNavigation") && waitNavigation.includes("async function waitForLoadState") && waitNavigation.includes("async function navigateAndWait"), "wait_navigation.js must own navigation and load-state helpers");
assert(waitNetworkIdle.includes("function compileNetworkIdleFilter") && waitNetworkIdle.includes("async function waitForNetworkIdle"), "wait_network_idle.js must own network-idle helpers");
assert(waitSelector.includes("PI_BROWSER_SELECTOR_PROBE_SOURCE") && waitSelector.includes("async function waitForSelector") && waitSelector.includes("function buildSelectorProbe"), "wait_selector.js must own selector probe helpers");
for (const forbidden of ["function acquirePiBrowserCdpDomain", "function subscribePiBrowserCdp", "function diagnosePiBrowserCdpDomainRefs"]) assert(!waitRuntime.includes(forbidden), `wait.js must not re-absorb CDP helper/state: ${forbidden}`);
assert(!/const\s+piBrowserCdpDomainRefs\s*=\s*new Map/.test(waitRuntime) && !/const\s+piBrowserCdpSubscriptions\s*=\s*new Map/.test(waitRuntime) && !/let\s+piBrowserCdpSubSeq\s*=\s*0/.test(waitRuntime), "wait.js must not re-absorb CDP maps/sequence state");
for (const forbidden of ["class WaitCoordinator", "function cleanupPiBrowserOrphanWaits", "function registerWait", "function cleanupEventSubscriptionsForTab", "function cleanupTabWaits", "function cancelWaitsForTab"]) assert(!waitRuntime.includes(forbidden), `wait.js must not re-absorb coordinator helper/state: ${forbidden}`);
assert(!/const\s+piBrowserWaits\s*=\s*new WaitCoordinator/.test(waitRuntime), "wait.js must not re-absorb wait coordinator state");
for (const forbidden of ["async function waitForNavigation", "async function waitForNetworkIdle", "async function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "function compileNetworkIdleFilter", "function buildSelectorProbe", "function loadStateSatisfied"]) assert(!waitRuntime.includes(forbidden), `wait.js must not re-absorb wait subsystem helper: ${forbidden}`);
for (const forbidden of ["function waitForNavigation", "function waitForNetworkIdle", "function waitForSelector", "function navigatePiBrowser", "function loadStateSatisfied"]) assert(!waitCdp.includes(forbidden), `wait_cdp.js must not own wait business logic: ${forbidden}`);
for (const forbidden of ["function waitForNavigation", "function waitForNetworkIdle", "function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "PI_BROWSER_SELECTOR_STABLE_SAMPLES", "function navigatePiBrowser", "function loadStateSatisfied"]) assert(!waitCoordinator.includes(forbidden), `wait_coordinator.js must not own navigation/networkIdle/selector business logic: ${forbidden}`);
for (const forbidden of ["async function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "async function waitForNetworkIdle", "function compileNetworkIdleFilter"]) assert(!waitNavigation.includes(forbidden), `wait_navigation.js must not own selector/networkIdle business logic: ${forbidden}`);
for (const forbidden of ["async function waitForNavigation", "async function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "function loadStateSatisfied"]) assert(!waitNetworkIdle.includes(forbidden), `wait_network_idle.js must not own navigation/selector business logic: ${forbidden}`);
for (const forbidden of ["async function waitForNavigation", "async function waitForNetworkIdle", "function compileNetworkIdleFilter", "function loadStateSatisfied"]) assert(!waitSelector.includes(forbidden), `wait_selector.js must not own navigation/networkIdle business logic: ${forbidden}`);
assert([waitCdp, waitCoordinator, waitNavigation, waitNetworkIdle, waitSelector, waitRuntime].every((source) => source.split(/\r?\n/).length <= 450), "wait split files must each stay below the TODO 183 health threshold");
assert(networkModel.includes("function normalizeNetworkRecorderConfig") && networkModel.includes("function storeNetworkBody") && /const\s+piBrowserNetworkRecorders\s*=\s*new Map/.test(networkModel), "network_model.js must own recorder state/config/body storage helpers");
const networkEvents = readServiceWorkerSource("network_events.js");
assert(networkRuntime.includes("async function cdpSendNetworkCommand") && networkRuntime.includes("async function handleNetworkRecorderCommand"), "network.js must own lifecycle and command dispatch");
assert(networkEvents.includes("function piNetworkHandleRecorderCdpEvent") && networkEvents.includes("async function piNetworkMaybeCaptureBody"), "network_events.js must own recorder CDP event decoding and body capture branching");
for (const forbidden of ["const PI_BROWSER_NETWORK_DEFAULT_MAX_ENTRIES", "function normalizeNetworkRecorderConfig", "function storeNetworkBody", "function truncateBase64Body"]) assert(!networkRuntime.includes(forbidden), `network.js must not re-absorb model helper: ${forbidden}`);
for (const forbidden of ["chrome.debugger.sendCommand", "function handleNetworkRecorderCdpEvent", "function handleNetworkRecorderCommand"]) assert(!networkModel.includes(forbidden), `network_model.js must not own runtime command logic: ${forbidden}`);
assert(networkModel.split(/\r?\n/).length <= 450 && networkEvents.split(/\r?\n/).length <= 450 && networkRuntime.split(/\r?\n/).length <= 550, "network recorder bridge files must stay below the split-file health threshold");
const wsModel = readServiceWorkerSource("ws_model.js");
const wsRuntime = readServiceWorkerSource("ws.js");
assert(wsModel.includes("const piBrowserWsSessions = new Map") && wsModel.includes("function createWsSession") && wsModel.includes("function wsSessionSummary"), "ws_model.js must own websocket session state/transcript helpers");
assert(wsRuntime.includes("async function handlePiBrowserWsCommand") || wsRuntime.includes("function handlePiBrowserWsCommand"), "ws.js must own websocket command dispatch");
assert(!wsRuntime.includes("const piBrowserWsSessions = new Map"), "ws.js must not re-absorb websocket model state");

const forbiddenNaming = [/TMWD/i, /TMWebDriver/i, /GABrowser/i, /GA_BROWSER/, /__GA/, /__ga/, /gaBrowser/, /gaPersistent/, /BrowserPro/, /browserPro/, /native_hook_dispatcher/, /tmwd_cdp_bridge/];
for (const file of serviceWorkerBridgeFiles) {
	const text = readServiceWorkerSource(file);
	new Function(executableBridgeSource(text, file));
	for (const pattern of forbiddenNaming) assert(!pattern.test(text), `${file} contains legacy naming: ${pattern}`);
	assert(!text.includes("browser_pro"), `${file} must not contain browser_pro compatibility routing`);
}
for (const file of ["hook_dispatcher.js", "disable_dialogs.js"]) {
	const text = readPageSource(file);
	new Function(executableBridgeSource(text, file));
	for (const pattern of forbiddenNaming) assert(!pattern.test(text), `${file} contains legacy naming: ${pattern}`);
}
assert(transport.split(/\r?\n/).length <= 230, "transport.js must stay focused on WebSocket lifecycle");
for (const forbidden of ["handleCookies", "handleBatch", "handleCDP", "handleTabsCommand", "chrome.scripting.executeScript", "validatePiBridgeProtocolMessage"]) assert(!transport.includes(forbidden), `transport.js must not own command business logic: ${forbidden}`);

assert(existsSync(path.join(root, "AI_INSTALL.md")), "AI_INSTALL.md install SOP must exist");
assert(existsSync(path.join(root, "docs", "browser-usage.md")), "docs/browser-usage.md migration note must exist");
assert(existsSync(path.join(root, "docs", "hook-dispatcher-boundary.md")), "docs/hook-dispatcher-boundary.md must freeze the page-injection boundary before bundler migration");
const hookBoundaryDoc = read("docs/hook-dispatcher-boundary.md");
assert(hookBoundaryDoc.includes("PI_BROWSER_HOOK_DISPATCHER_FILE") && hookBoundaryDoc.includes("chrome.scripting.executeScript") && hookBoundaryDoc.includes("CDP fallback") && hookBoundaryDoc.includes("TODO 190"), "hook dispatcher boundary doc must cover injection paths and the deferred page bundle migration");
assert(existsSync(path.join(root, "docs", "bridge-esm-bundler-plan.md")), "docs/bridge-esm-bundler-plan.md must freeze the ESM/bundler migration design before code migration");
const bridgeBundlerPlan = read("docs/bridge-esm-bundler-plan.md");
for (const required of ["bridge_src", "bridge/pi_browser_bridge/dist", "esbuild", "service-worker", "hook-dispatcher", "disable-dialogs", "TODO 188", "TODO 193", "Old hand-written `background.js importScripts"]) {
	assert(bridgeBundlerPlan.includes(required), `bridge ESM/bundler plan missing required boundary: ${required}`);
}
assert(read("AI_INSTALL.md").includes("PI_BROWSER_BRIDGE_PORT") && read("AI_INSTALL.md").includes("/browser-status"), "AI_INSTALL.md must own environment and diagnostics instructions");
assert(readdirSync(path.join(root, "src", "tools", "summaries")).length >= 5, "summary modules must stay split");
console.log("bridge files contract ok");
