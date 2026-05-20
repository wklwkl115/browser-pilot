import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const networkBridgeRuntimeFiles = ["network_model.js", "network.js"];
const serviceWorkerBridgeFiles = ["config.js", "protocol.js", "patterns.js", "cdp.js", "runtime.js", ...waitBridgeRuntimeFiles, ...networkBridgeRuntimeFiles, "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "router.js", "tab_sync.js", "transport.js"];

const requiredBridgeFiles = [
	"manifest.json", "background.js", "protocol.js", "patterns.js", "cdp.js", "runtime.js", "wait_cdp.js", "wait_coordinator.js", "wait_navigation.js", "wait_network_idle.js", "wait_selector.js", "wait.js", "network_model.js", "network.js", "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "router.js", "tab_sync.js", "transport.js", "hook_dispatcher.js", "content.js", "config.js", "disable_dialogs.js", "popup.html", "popup.js", "native_command_schema.json",
];
for (const file of requiredBridgeFiles) assert(existsSync(path.join(bridge, file)), `missing bridge file: ${file}`);

const pkg = JSON.parse(read("package.json"));
assert(pkg.version === "0.3.0", "package version must be 0.3.0");
assert(pkg.keywords?.includes("pi-package"), "package must declare pi-package keyword");
assert(pkg.pi?.extensions?.includes("./index.ts"), "package pi manifest must expose index.ts");
assert(pkg.scripts?.["sync:protocol"] === "node scripts/sync-native-protocol.mjs", "package must expose protocol sync script");
assert(pkg.scripts?.["sync:config"] === "node scripts/sync-bridge-config.mjs", "package must expose bridge config sync script");
assert(pkg.scripts?.["check:bridge:types"] === "tsc -p tsconfig.bridge.json", "package must expose bridge checkJs typecheck script");
assert(String(pkg.scripts?.["check:bridge"] || "").includes("check:bridge:types"), "bridge checks must include bridge checkJs typecheck");
assert(pkg.devDependencies?.typescript, "package must depend on TypeScript for bridge checkJs typecheck");
const bridgeTsconfig = JSON.parse(read("tsconfig.bridge.json"));
assert(bridgeTsconfig.compilerOptions?.allowJs === true && bridgeTsconfig.compilerOptions?.checkJs === true && bridgeTsconfig.compilerOptions?.noEmit === true, "bridge tsconfig must enable allowJs/checkJs/noEmit");
assert(bridgeTsconfig.include?.includes("bridge/pi_browser_bridge/*.js") && bridgeTsconfig.include?.includes("bridge/pi_browser_bridge/bridge-globals.d.ts"), "bridge tsconfig must cover bridge JS and ambient globals");
assert(existsSync(path.join(bridge, "bridge-globals.d.ts")), "bridge ambient globals file must exist");
const bridgeGlobals = read("bridge/pi_browser_bridge/bridge-globals.d.ts");
for (const forbidden of ["Record<string, any>", "[key: string]: any", "declare const chrome: any", "validateCommand?: (msg: any", "onmessage?: ((event: { data: any })"]) {
	assert(!bridgeGlobals.includes(forbidden), `bridge ambient globals must not reintroduce broad any typing: ${forbidden}`);
}
for (const required of ["type PiChromeApi", "type PiChromeDebuggerApi", "type PiPersistentCdpBridge", "type PiBridgeWsEnvelope", "type PiBrowserNetworkRecorder", "type PiBrowserHookCommand", "type PiBrowserCdpSubscriptionRecord"]) {
	assert(bridgeGlobals.includes(required), `bridge ambient globals must define concrete boundary type: ${required}`);
}

const manifest = JSON.parse(read("bridge/pi_browser_bridge/manifest.json"));
assert(manifest.name === "Pi Native Browser Bridge", "manifest name must be Pi Native Browser Bridge");
assert(manifest.version === "0.3.0", "manifest version must be 0.3.0");
assert(manifest.background?.service_worker === "background.js", "manifest must use background.js service worker");
assert(manifest.permissions?.includes("downloads"), "manifest must declare downloads permission for browser_download path return");

const background = read("bridge/pi_browser_bridge/background.js");
const bridgeInfo = read("bridge/pi_browser_bridge/bridge_info.js");
const transport = read("bridge/pi_browser_bridge/transport.js");
const router = read("bridge/pi_browser_bridge/router.js");
const runtimeBridge = read("bridge/pi_browser_bridge/runtime.js");
const hookBridge = read("bridge/pi_browser_bridge/hook.js");
const hookDispatcher = read("bridge/pi_browser_bridge/hook_dispatcher.js");
const waitCdp = read("bridge/pi_browser_bridge/wait_cdp.js");
const waitCoordinator = read("bridge/pi_browser_bridge/wait_coordinator.js");
const waitNavigation = read("bridge/pi_browser_bridge/wait_navigation.js");
const waitNetworkIdle = read("bridge/pi_browser_bridge/wait_network_idle.js");
const waitSelector = read("bridge/pi_browser_bridge/wait_selector.js");
const waitRuntime = read("bridge/pi_browser_bridge/wait.js");
const networkModel = read("bridge/pi_browser_bridge/network_model.js");
const networkRuntime = read("bridge/pi_browser_bridge/network.js");
assert(background.includes("@ts-check") && bridgeInfo.includes("@ts-check") && router.includes("@ts-check"), "bridge bootstrap/core entrypoints must opt into JS type checking documentation");
assert(router.includes("@param {PiBridgeCommand}") && router.includes("@param {PiBridgeWebSocketLike}"), "router must document bridge envelope/socket JSDoc types");
assert(router.includes("@param {PiBridgeWsEnvelope}") && runtimeBridge.includes("PiBridgeGlobalThis"), "bridge runtime/router must consume tightened ambient boundary types");
assert(bridgeInfo.includes("manifest.version_name || manifest.version"), "bridge_info must report display version_name when available");
for (const file of serviceWorkerBridgeFiles) assert(background.includes(file), `background.js must import ${file}`);
assertBackgroundOrder(background, serviceWorkerBridgeFiles, "background service worker script order");
assert(background.indexOf("protocol.js") < background.indexOf("runtime.js"), "background.js must load protocol.js before runtime.js");
assert(background.indexOf("protocol.js") < background.indexOf("router.js"), "background.js must load protocol.js before router.js");
assert(background.indexOf("router.js") < background.indexOf("transport.js"), "background.js must load router.js before transport.js");
assert(background.indexOf("tab_sync.js") < background.indexOf("transport.js"), "background.js must load tab_sync.js before transport.js");
assert(!background.includes("hook_dispatcher.js"), "hook_dispatcher.js must stay out of the service worker importScripts graph");
assert(runtimeBridge.includes("const PI_BROWSER_HOOK_DISPATCHER_FILE = 'hook_dispatcher.js';"), "runtime.js must own the stable hook dispatcher filename");
assert(runtimeBridge.includes("window.__PI_BROWSER_HOOKS__ && window.__PI_BROWSER_HOOKS__.dispatch"), "runtime page calls must dispatch through the stable hook page global");
assert(hookBridge.includes("chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [PI_BROWSER_HOOK_DISPATCHER_FILE] })"), "hook.js must inject the dispatcher through the stable file constant");
assert(hookBridge.includes("fetch(chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE))"), "hook.js CDP fallback must fetch the same dispatcher file constant");
assert(hookDispatcher.includes(";(function PiBrowserHookDispatcher()") && hookDispatcher.includes("window.__PI_BROWSER_HOOKS__ = {"), "hook_dispatcher.js must remain a self-contained page IIFE exposing window.__PI_BROWSER_HOOKS__");
assert(!/\bimport\s+|\bimport\s*\(|\bexport\s+|importScripts\s*\(/.test(hookDispatcher), "hook_dispatcher.js must not depend on page-side imports before TODO 190 bundle migration");
assert(!/chrome\./.test(hookDispatcher), "hook_dispatcher.js must not call Chrome extension APIs from the page MAIN world");
assert(waitBridgeRuntimeFiles.at(-1) === "wait.js", "wait bridge runtime bundle must keep wait.js as the final facade/dispatch script");
assert(waitBridgeRuntimeFiles[0] === "wait_cdp.js" && waitBridgeRuntimeFiles[1] === "wait_coordinator.js" && waitBridgeRuntimeFiles.at(-1) === "wait.js", "wait helper modules must load before final wait.js facade");
assert(waitCdp.includes("const piBrowserCdpDomainRefs = new Map()") && waitCdp.includes("function acquirePiBrowserCdpDomain") && waitCdp.includes("function subscribePiBrowserCdp") && waitCdp.includes("function diagnosePiBrowserCdpCleanupHistory"), "wait_cdp.js must own CDP refcount/subscription/cleanup diagnostics helpers");
assert(waitCoordinator.includes("class WaitCoordinator") && waitCoordinator.includes("const piBrowserWaits = new WaitCoordinator()") && waitCoordinator.includes("function cleanupPiBrowserOrphanWaits") && waitCoordinator.includes("function cleanupEventSubscriptionsForTab"), "wait_coordinator.js must own wait registry, orphan cleanup, and event subscription helpers");
assert(waitNavigation.includes("async function waitForNavigation") && waitNavigation.includes("async function waitForLoadState") && waitNavigation.includes("async function navigateAndWait"), "wait_navigation.js must own navigation and load-state helpers");
assert(waitNetworkIdle.includes("function compileNetworkIdleFilter") && waitNetworkIdle.includes("async function waitForNetworkIdle"), "wait_network_idle.js must own network-idle helpers");
assert(waitSelector.includes("PI_BROWSER_SELECTOR_PROBE_SOURCE") && waitSelector.includes("async function waitForSelector") && waitSelector.includes("function buildSelectorProbe"), "wait_selector.js must own selector probe helpers");
for (const forbidden of ["const piBrowserCdpDomainRefs = new Map()", "const piBrowserCdpSubscriptions = new Map()", "let piBrowserCdpSubSeq = 0", "function acquirePiBrowserCdpDomain", "function subscribePiBrowserCdp", "function diagnosePiBrowserCdpDomainRefs"]) assert(!waitRuntime.includes(forbidden), `wait.js must not re-absorb CDP helper/state: ${forbidden}`);
for (const forbidden of ["class WaitCoordinator", "const piBrowserWaits = new WaitCoordinator()", "function cleanupPiBrowserOrphanWaits", "function registerWait", "function cleanupEventSubscriptionsForTab", "function cleanupTabWaits", "function cancelWaitsForTab"]) assert(!waitRuntime.includes(forbidden), `wait.js must not re-absorb coordinator helper/state: ${forbidden}`);
for (const forbidden of ["async function waitForNavigation", "async function waitForNetworkIdle", "async function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "function compileNetworkIdleFilter", "function buildSelectorProbe", "function loadStateSatisfied"]) assert(!waitRuntime.includes(forbidden), `wait.js must not re-absorb wait subsystem helper: ${forbidden}`);
for (const forbidden of ["function waitForNavigation", "function waitForNetworkIdle", "function waitForSelector", "function navigatePiBrowser", "function loadStateSatisfied"]) assert(!waitCdp.includes(forbidden), `wait_cdp.js must not own wait business logic: ${forbidden}`);
for (const forbidden of ["function waitForNavigation", "function waitForNetworkIdle", "function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "PI_BROWSER_SELECTOR_STABLE_SAMPLES", "function navigatePiBrowser", "function loadStateSatisfied"]) assert(!waitCoordinator.includes(forbidden), `wait_coordinator.js must not own navigation/networkIdle/selector business logic: ${forbidden}`);
for (const forbidden of ["async function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "async function waitForNetworkIdle", "function compileNetworkIdleFilter"]) assert(!waitNavigation.includes(forbidden), `wait_navigation.js must not own selector/networkIdle business logic: ${forbidden}`);
for (const forbidden of ["async function waitForNavigation", "async function waitForSelector", "PI_BROWSER_SELECTOR_PROBE_SOURCE", "function loadStateSatisfied"]) assert(!waitNetworkIdle.includes(forbidden), `wait_network_idle.js must not own navigation/selector business logic: ${forbidden}`);
for (const forbidden of ["async function waitForNavigation", "async function waitForNetworkIdle", "function compileNetworkIdleFilter", "function loadStateSatisfied"]) assert(!waitSelector.includes(forbidden), `wait_selector.js must not own navigation/networkIdle business logic: ${forbidden}`);
assert([waitCdp, waitCoordinator, waitNavigation, waitNetworkIdle, waitSelector, waitRuntime].every((source) => source.split(/\r?\n/).length <= 450), "wait split files must each stay below the TODO 183 health threshold");
assert(networkModel.includes("function normalizeNetworkRecorderConfig") && networkModel.includes("function storeNetworkBody") && networkModel.includes("const piBrowserNetworkRecorders = new Map()"), "network_model.js must own recorder state/config/body storage helpers");
assert(networkRuntime.includes("async function cdpSendNetworkCommand") && networkRuntime.includes("function handleNetworkRecorderCdpEvent") && networkRuntime.includes("async function handleNetworkRecorderCommand"), "network.js must own CDP events, lifecycle, and command dispatch");
for (const forbidden of ["const PI_BROWSER_NETWORK_DEFAULT_MAX_ENTRIES", "function normalizeNetworkRecorderConfig", "function storeNetworkBody", "function truncateBase64Body"]) assert(!networkRuntime.includes(forbidden), `network.js must not re-absorb model helper: ${forbidden}`);
for (const forbidden of ["chrome.debugger.sendCommand", "function handleNetworkRecorderCdpEvent", "function handleNetworkRecorderCommand"]) assert(!networkModel.includes(forbidden), `network_model.js must not own runtime command logic: ${forbidden}`);
assert(networkModel.split(/\r?\n/).length <= 450 && networkRuntime.split(/\r?\n/).length <= 550, "network recorder bridge files must stay below the split-file health threshold");

const forbiddenNaming = [/TMWD/i, /TMWebDriver/i, /GABrowser/i, /GA_BROWSER/, /__GA/, /__ga/, /gaBrowser/, /gaPersistent/, /BrowserPro/, /browserPro/, /native_hook_dispatcher/, /tmwd_cdp_bridge/];
for (const file of requiredBridgeFiles.filter((item) => item.endsWith(".js"))) {
	const text = read(`bridge/pi_browser_bridge/${file}`);
	new Function(text);
	for (const pattern of forbiddenNaming) assert(!pattern.test(text), `${file} contains legacy naming: ${pattern}`);
	assert(!text.includes("browser_pro"), `${file} must not contain browser_pro compatibility routing`);
}
assert(transport.split(/\r?\n/).length <= 150, "transport.js must stay focused on WebSocket lifecycle");
for (const forbidden of ["handleCookies", "handleBatch", "handleCDP", "handleTabsCommand", "chrome.scripting.executeScript", "validatePiBridgeProtocolMessage"]) assert(!transport.includes(forbidden), `transport.js must not own command business logic: ${forbidden}`);

assert(existsSync(path.join(root, "AI_INSTALL.md")), "AI_INSTALL.md install SOP must exist");
assert(existsSync(path.join(root, "docs", "browser-usage.md")), "docs/browser-usage.md migration note must exist");
assert(existsSync(path.join(root, "docs", "hook-dispatcher-boundary.md")), "docs/hook-dispatcher-boundary.md must freeze the page-injection boundary before bundler migration");
const hookBoundaryDoc = read("docs/hook-dispatcher-boundary.md");
assert(hookBoundaryDoc.includes("PI_BROWSER_HOOK_DISPATCHER_FILE") && hookBoundaryDoc.includes("chrome.scripting.executeScript") && hookBoundaryDoc.includes("CDP fallback") && hookBoundaryDoc.includes("TODO 190"), "hook dispatcher boundary doc must cover injection paths and the deferred page bundle migration");
assert(read("AI_INSTALL.md").includes("PI_BROWSER_BRIDGE_PORT") && read("AI_INSTALL.md").includes("/browser-status"), "AI_INSTALL.md must own environment and diagnostics instructions");
assert(readdirSync(path.join(root, "src", "tools", "summaries")).length >= 5, "summary modules must stay split");
console.log("bridge files contract ok");
