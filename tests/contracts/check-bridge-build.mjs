import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const pkg = readJson("package.json");
assert.equal(pkg.scripts?.["build:bridge"], "node scripts/build-bridge.mjs", "package must expose build:bridge");
assert.equal(pkg.scripts?.["verify:bridge:dist"], "node tests/contracts/check-bridge-build.mjs", "package must expose a read-only bridge dist verification command");
assert.equal(pkg.scripts?.["check:bridge:build"], "npm run verify:bridge:dist", "bridge build check must verify the current dist instead of rebuilding it");
assert(String(pkg.scripts?.["check:bridge"] || "").includes("check:bridge:build"), "bridge check must include build pipeline validation");
assert(pkg.devDependencies?.esbuild, "bridge build pipeline must depend on esbuild as an explicit dev dependency");

for (const distRel of [
	"bridge/pi_browser_bridge/dist/service-worker.js",
	"bridge/pi_browser_bridge/dist/content.js",
	"bridge/pi_browser_bridge/dist/hook_dispatcher.js",
	"bridge/pi_browser_bridge/dist/disable_dialogs.js",
	"bridge/pi_browser_bridge/dist/build-manifest.json",
]) {
	assert(existsSync(path.join(root, distRel)), `missing generated dist file: ${distRel}. Run npm run build:bridge first.`);
}

const manifest = readJson("bridge/pi_browser_bridge/manifest.json");
assert.equal(manifest.background?.service_worker, "dist/service-worker.js", "manifest must use the generated dist service worker after TODO 191");
assert.equal(manifest.background?.type, "module", "dist service worker must run as an MV3 module service worker");
assert.deepEqual(manifest.content_scripts?.[0]?.js, ["dist/disable_dialogs.js"], "manifest document_start content script must use dist disable-dialogs bundle");
assert.deepEqual(manifest.content_scripts?.[1]?.js, ["dist/content.js"], "manifest document_idle content script must use dist content bundle without ambient config.js");

assert(existsSync(path.join(root, "bridge_src", "service-worker.ts")), "bridge_src service-worker module-order entry must exist");
assert(existsSync(path.join(root, "bridge_src", "shared", "buildInfo.ts")), "bridge_src shared build type must exist");
assert(existsSync(path.join(root, "bridge_src", "service_worker", "runtimeEnv.ts")), "TODO 197 must provide a typed service-worker runtime environment boundary");
assert(existsSync(path.join(root, "bridge_src", "service_worker", "types.ts")), "TODO 197 must provide shared foundation bridge types");
for (const pageScript of ["content", "hook_dispatcher", "disable_dialogs"]) {
	assert(existsSync(path.join(root, "bridge_src", "page_scripts", `${pageScript}.ts`)), `bridge_src page script module missing: ${pageScript}`);
}
assert(read("bridge_src/page_scripts/content.ts").includes("import { TID } from \"../shared/protocol\""), "content page source must own an explicit shared TID import instead of ambient config.js");
assert(!/\bimport\s+|\bimport\s*\(|\bimportScripts\s*\(|\bchrome\./.test(read("bridge_src/page_scripts/hook_dispatcher.ts")), "hook dispatcher page source must not import modules or call background-only Chrome APIs");
assert(!/\bimport\s+|\bimport\s*\(|\bimportScripts\s*\(|\bchrome\./.test(read("bridge_src/page_scripts/disable_dialogs.ts")), "disable-dialogs page source must not import modules or call background-only Chrome APIs");
for (const moduleName of ["runtime", "cdp", "wait_cdp", "wait_coordinator", "wait_navigation", "wait_network_idle", "wait_selector", "wait", "network_model", "network", "hook", "frame", "html", "screenshot", "transfer", "router", "tab_sync", "transport"]) {
	assert(existsSync(path.join(root, "bridge_src", "service_worker", `${moduleName}.ts`)), `bridge_src service worker module missing: ${moduleName}`);
	assert(read("bridge_src/service-worker.ts").includes(`__piBridgeModule_${moduleName}`) && read("bridge_src/service-worker.ts").includes(`./service_worker/${moduleName}`), `service-worker entry must import module symbol ${moduleName}`);
	assert(read(`bridge_src/service_worker/${moduleName}.ts`).includes(`export const __piBridgeModule_${moduleName}`), `service worker module must export explicit boundary symbol: ${moduleName}`);
}
assert(existsSync(path.join(root, "bridge", "pi_browser_bridge", "dist", ".gitignore")), "dist must declare generated-file boundary");
assert(read("bridge/pi_browser_bridge/dist/.gitignore").includes("!.gitignore"), "dist .gitignore must keep only the generated-file marker tracked");
assert(existsSync(path.join(root, "bridge", "pi_browser_bridge", "dist", ".npmignore")), "dist must declare npm package boundary");
assert(read("bridge/pi_browser_bridge/dist/.npmignore").includes("include the generated dist runtime"), "dist .npmignore must override dist .gitignore for npm packages");

const buildManifest = readJson("bridge/pi_browser_bridge/dist/build-manifest.json");
assert.equal(buildManifest.generated, true, "build manifest must mark dist as generated");
assert.equal(buildManifest.runtimeSwitched, true, "build manifest must record that manifest/runtime has switched to dist");
assert.equal(buildManifest.manifestTarget, "dist/service-worker.js", "build manifest must record current manifest target");
assert.equal(buildManifest.serviceWorkerBuildMode, "esm-import-graph", "build manifest must record the final service worker ESM import graph mode");
assert.equal(buildManifest.targetServiceWorkerBuildMode, "esm-import-graph", "build manifest target must match the active service worker build mode");
assert.equal(buildManifest.orderedConcatenation, false, "TODO 199 must remove ordered source concatenation from the service worker build");
assert.equal(buildManifest.foundationImported, true, "TODO 197 must import foundation modules through the ESM graph");
assert.equal(buildManifest.commandImported, true, "TODO 198 must import command modules through the ESM graph");
assert.equal(buildManifest.startupImported, true, "TODO 199 must import startup modules through the ESM graph");
assert.equal(buildManifest.serviceWorkerModules, undefined, "TODO 199 must remove the ordered-concat serviceWorkerModules manifest list");
assert.equal(buildManifest.metadataOnlyModuleLists, true, "build manifest must label module lists as metadata-only");
const buildScript = read("scripts/build-bridge.mjs");
assert(!buildScript.includes("readFile") && !buildScript.includes("stdin:") && !buildScript.includes("service-worker.generated"), "TODO 199 build script must not assemble the service worker from source text");
assert.deepEqual(buildManifest.entries.map((entry) => entry.name), ["service-worker", "content", "hook-dispatcher", "disable-dialogs"], "build manifest must record independent service-worker and page-script bundle entries");
assert.deepEqual(buildManifest.pageScriptEntries.map((entry) => entry.name), ["content", "hook-dispatcher", "disable-dialogs"], "build manifest must keep page scripts separate from the service-worker bundle");
assert.deepEqual(buildManifest.metadataOnlyServiceWorkerFoundationModules, ["config", "protocol", "patterns", "cdp", "runtime", "wait_cdp", "wait_coordinator", "wait_navigation", "wait_network_idle", "wait_selector", "wait"], "build manifest must record TODO 197 foundation ESM modules as metadata-only");
for (const foundation of buildManifest.metadataOnlyServiceWorkerFoundationModules) {
	const source = read(`bridge_src/service_worker/${foundation}.ts`);
	assert(!source.includes("@ts-nocheck"), `TODO 197 foundation module must be type-checked: ${foundation}`);
	assert(source.includes(`export const __piBridgeModule_${foundation}`), `TODO 197 foundation module must keep explicit module boundary: ${foundation}`);
	if (!["config", "protocol", "patterns"].includes(foundation)) assert(/^import\s+/m.test(source), `TODO 197 foundation module must express dependencies through ESM imports: ${foundation}`);
}
const runtimeSource = read("bridge_src/service_worker/runtime.ts");
const commandModules = ["network_model", "network", "hook", "evidence", "frame", "html", "screenshot", "transfer", "bridge_info", "core_commands", "exec"];
assert.deepEqual(buildManifest.metadataOnlyServiceWorkerCommandModules, commandModules, "build manifest must record TODO 198 command ESM modules as metadata-only");
for (const command of commandModules) {
	const source = read(`bridge_src/service_worker/${command}.ts`);
	assert(!source.includes("@ts-nocheck"), `TODO 198 command module must be type-checked: ${command}`);
	assert(/^import\s+/m.test(source), `TODO 198 command module must express dependencies through ESM imports: ${command}`);
	assert(source.includes(`export const __piBridgeModule_${command}`), `TODO 198 command module must keep explicit module boundary: ${command}`);
}
const coreCommandsSource = read("bridge_src/service_worker/core_commands.ts");
const routerSource = read("bridge_src/service_worker/router.ts");
assert(coreCommandsSource.includes("async function dispatchPiBridgeCommand") && coreCommandsSource.includes("await dispatchPiBridgeCommand(validation.command, sender)") && !coreCommandsSource.includes("handlePiBridgeMessage(c, sender)"), "TODO 198 batch must use command-layer dispatch helper instead of router side effects");
assert(routerSource.includes("dispatchPiBridgeCommand(validation.command, sender)") && !routerSource.includes("if (msg.cmd === 'cookies')"), "TODO 198 router must delegate command dispatch to the command-layer helper");
assert(runtimeSource.includes("from \"./network\"") && runtimeSource.includes("handleNetworkRecorderCommand") && runtimeSource.includes("from \"./hook\"") && runtimeSource.includes("handlePiBrowserHookCommand"), "TODO 198 runtime must call command modules through ESM imports");
for (const legacyHandler of ["handleNetworkRecorderCommand", "handlePiBrowserHookCommand", "handlePiBrowserEvidenceCommand", "handlePiBrowserFrameCommand", "handlePiBrowserTransferCommand", "handlePiBrowserHtml", "captureScreenshotWithRetry"]) {
	assert(!runtimeSource.includes(`requireLegacyCommand('${legacyHandler}')`), `runtime must not route command handler through legacy global: ${legacyHandler}`);
}
assert(!runtimeSource.includes("typeof cleanupPiBrowserPageListenersForTab") && !runtimeSource.includes("optionalLegacyCommand") && !runtimeSource.includes("requireLegacyCommand") && !runtimeSource.includes("legacyCommandSurface"), "runtime must not use ambient legacy command globals after TODO 199");
const startupModules = ["router", "tab_sync", "transport"];
assert.deepEqual(buildManifest.metadataOnlyServiceWorkerStartupModules, startupModules, "build manifest must record TODO 199 startup ESM modules as metadata-only");
assert.deepEqual(buildManifest.metadataOnlyLegacyServiceWorkerModules, [], "TODO 199 must remove the ordered-concat startup tail");
for (const startup of startupModules) {
	const source = read(`bridge_src/service_worker/${startup}.ts`);
	assert(!source.includes("@ts-nocheck"), `TODO 199 startup module must be type-checked: ${startup}`);
	assert(/^import\s+/m.test(source), `TODO 199 startup module must express dependencies through ESM imports: ${startup}`);
	assert(source.includes(`export const __piBridgeModule_${startup}`), `TODO 199 startup module must keep explicit module boundary: ${startup}`);
}

const bundle = read("bridge/pi_browser_bridge/dist/service-worker.js");
assert(bundle.startsWith("// Generated by scripts/build-bridge.mjs. Do not edit by hand."), "dist bundle must carry generated-file banner");
assert(bundle.includes("bridge-build-dist-v1") && bundle.includes("__PI_BROWSER_EXPERIMENTAL_BUILD__"), "dist bundle must contain the typed runtime build marker");
assert(bundle.includes("runtimeSwitched: true") && bundle.includes('mode: "production"'), "dist service-worker bundle must expose production runtime build metadata");
assert(!bundle.includes("importScripts("), "ESM service-worker bundle must not emit importScripts");
assert(!bundle.includes("PiBrowserHookDispatcher"), "service-worker bundle must not inline the MAIN-world hook dispatcher page script");
assert(!bundle.includes("Object.assign(globalThis, module.symbols)") && !bundle.includes("__piBridgeFoundationModules") && !bundle.includes("__piBridgeCommandModules"), "TODO 199 service-worker bundle must not publish imported module symbols through startup globals");
for (const moduleName of [...buildManifest.metadataOnlyServiceWorkerFoundationModules, ...buildManifest.metadataOnlyServiceWorkerCommandModules, ...buildManifest.metadataOnlyServiceWorkerStartupModules]) assert(!bundle.includes(`// ---- bridge_src/service_worker/${moduleName}.ts ----`), `service worker module must not be text-concatenated: ${moduleName}`);
for (const command of buildManifest.metadataOnlyServiceWorkerCommandModules) assert(bundle.includes(`__piBridgeModule_${command}`), `command module must be present through the imported ESM graph: ${command}`);
for (const startup of buildManifest.metadataOnlyServiceWorkerStartupModules) assert(bundle.includes(`__piBridgeModule_${startup}`), `startup module must be present through the imported ESM graph: ${startup}`);
for (const required of ["PI_BROWSER_BRIDGE_WS_URL", "PI_BROWSER_HOOK_DISPATCHER_FILE", "dist/hook_dispatcher.js", "matchNetworkPattern", "async function handlePiBrowser", "handleNetworkRecorderCommand", "handlePiBrowserHookCommand", "function installPiBrowserServiceWorker", "function installPiBridgeRouter", "function installPiBrowserTransport", "function installPiBrowserTabSync", "function connectWS"]) {
	assert(bundle.includes(required), `service-worker bundle must include migrated runtime symbol: ${required}`);
}
assert(existsSync(path.join(root, "bridge", "pi_browser_bridge", "dist", "service-worker.js.map")), "build pipeline must emit a source map for the experimental bundle");

const distPageScripts = {
	content: read("bridge/pi_browser_bridge/dist/content.js"),
	"hook-dispatcher": read("bridge/pi_browser_bridge/dist/hook_dispatcher.js"),
	"disable-dialogs": read("bridge/pi_browser_bridge/dist/disable_dialogs.js"),
};
for (const [name, script] of Object.entries(distPageScripts)) {
	assert(script.startsWith("// Generated by scripts/build-bridge.mjs. Do not edit by hand."), `dist ${name} bundle must carry generated-file banner`);
	assert(!/\bimport\s+|\bimport\s*\(|\bexport\s+|importScripts\s*\(/.test(script), `dist ${name} bundle must be a self-contained page script`);
	assert(existsSync(path.join(root, "bridge", "pi_browser_bridge", "dist", `${name === "hook-dispatcher" ? "hook_dispatcher" : name === "disable-dialogs" ? "disable_dialogs" : name}.js.map`)), `dist ${name} bundle must emit a source map`);
}
assert(distPageScripts.content.includes("__pi_browser_bridge_request__") && distPageScripts.content.includes("bridge_wake") && distPageScripts.content.includes("MutationObserver"), "dist content bundle must include content bridge behavior and explicit TID value");
assert(!/chrome\.debugger|WebSocket|connectWS/.test(distPageScripts.content), "dist content bundle must not include background transport/debugger code");
assert(distPageScripts["hook-dispatcher"].includes("PiBrowserHookDispatcher") && distPageScripts["hook-dispatcher"].includes("window.__PI_BROWSER_HOOKS__"), "dist hook dispatcher bundle must preserve the page dispatcher global");
assert(!/chrome\.|PI_BROWSER_BRIDGE_WS_URL|connectWS/.test(distPageScripts["hook-dispatcher"]), "dist hook dispatcher bundle must not include background-only APIs");
assert(distPageScripts["disable-dialogs"].includes("window.prompt") && distPageScripts["disable-dialogs"].includes("promptAcceptedValue"), "dist disable-dialogs bundle must preserve prompt override semantics");
assert(!/chrome\.|PI_BROWSER_BRIDGE_WS_URL|connectWS/.test(distPageScripts["disable-dialogs"]), "dist disable-dialogs bundle must not include background-only APIs");

function eventStore() {
	const listeners = [];
	return {
		listeners,
		addListener(callback) { listeners.push(callback); },
		removeListener(callback) {
			const index = listeners.indexOf(callback);
			if (index >= 0) listeners.splice(index, 1);
		},
	};
}

const runtimeOnMessage = eventStore();
const runtimeOnInstalled = eventStore();
const runtimeOnStartup = eventStore();
const debuggerOnDetach = eventStore();
const debuggerOnEvent = eventStore();
const alarmsOnAlarm = eventStore();
const tabsOnCreated = eventStore();
const tabsOnUpdated = eventStore();
const tabsOnRemoved = eventStore();
const webNavigationEvents = Object.fromEntries(["onBeforeNavigate", "onCommitted", "onCompleted", "onErrorOccurred", "onHistoryStateUpdated", "onReferenceFragmentUpdated"].map((name) => [name, eventStore()]));
const oldChrome = globalThis.chrome;
const oldSelf = globalThis.self;
const oldNavigator = globalThis.navigator;
const oldFetch = globalThis.fetch;
const oldWebSocket = globalThis.WebSocket;
globalThis.self = globalThis;
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "bridge-build-contract" }, configurable: true });
globalThis.fetch = async () => { throw new Error("fixture offline"); };
globalThis.WebSocket = class FixtureWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FixtureWebSocket.CLOSED;
	constructor() { throw new Error("fixture websocket disabled"); }
};
globalThis.chrome = {
	runtime: {
		id: "bridge-build-contract",
		getManifest: () => ({ name: "Pi Native Browser Bridge", version: "0.3.0", version_name: "0.3.0-test" }),
		getURL: (item) => `chrome-extension://fixture/${item}`,
		reload() {},
		sendMessage: async () => ({ ok: true, data: [] }),
		onMessage: runtimeOnMessage,
		onInstalled: runtimeOnInstalled,
		onStartup: runtimeOnStartup,
	},
	debugger: {
		attach: async () => {},
		detach: async () => {},
		sendCommand: async () => ({}),
		getTargets: async () => [],
		onDetach: debuggerOnDetach,
		onEvent: debuggerOnEvent,
	},
	tabs: {
		query: async () => [],
		update: async (_tabId, updateProperties) => ({ id: _tabId, tabId: _tabId, ...updateProperties }),
		create: async (createProperties) => ({ id: 1, tabId: 1, ...createProperties }),
		get: async (tabId) => ({ id: tabId, tabId, url: "about:blank", active: true, windowId: 1 }),
		remove: async () => {},
		captureVisibleTab: async () => "data:image/png;base64,AA==",
		onCreated: tabsOnCreated,
		onUpdated: tabsOnUpdated,
		onRemoved: tabsOnRemoved,
	},
	windows: { update: async () => ({}) },
	scripting: { executeScript: async () => [] },
	downloads: { download() {}, search(_query, callback) { callback([]); }, onChanged: eventStore(), onCreated: eventStore() },
	cookies: { getAll: async () => [] },
	management: { getAll: async () => [], setEnabled: async () => {} },
	alarms: { create() {}, onAlarm: alarmsOnAlarm },
	contentSettings: { automaticDownloads: { set: async () => {} } },
	declarativeNetRequest: { updateDynamicRules: async () => {} },
	webNavigation: webNavigationEvents,
};
try {
	await import(`${pathToFileURL(path.join(root, "bridge", "pi_browser_bridge", "dist", "service-worker.js")).href}?contract=${Date.now()}`);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(globalThis.__PI_BROWSER_EXPERIMENTAL_BUILD__?.runtimeSwitched, true, "imported service-worker bundle must expose dist runtime build metadata");
	assert.equal(globalThis.__PI_BROWSER_EXPERIMENTAL_BUILD__?.mode, "production", "imported service-worker bundle must expose production build mode");
	assert(runtimeOnMessage.listeners.length > 0, "imported service-worker bundle must register runtime message dispatch");
	assert(runtimeOnInstalled.listeners.length > 0 && runtimeOnStartup.listeners.length > 0, "imported service-worker bundle must register lifecycle listeners");
	assert(debuggerOnDetach.listeners.length > 0 && alarmsOnAlarm.listeners.length > 0, "imported service-worker bundle must register debugger/alarms listeners");
	assert(tabsOnCreated.listeners.length > 0 && tabsOnUpdated.listeners.length > 0 && tabsOnRemoved.listeners.length > 0, "imported service-worker bundle must register tab sync listeners");
} finally {
	globalThis.chrome = oldChrome;
	globalThis.self = oldSelf;
	Object.defineProperty(globalThis, "navigator", { value: oldNavigator, configurable: true });
	globalThis.fetch = oldFetch;
	globalThis.WebSocket = oldWebSocket;
}

for (const file of ["README.md", "AI_INSTALL.md", "docs/bridge-esm-bundler-plan.md"]) {
	const text = read(file);
	assert(text.includes("build:bridge"), `${file} must document the bridge build pipeline`);
	assert(text.includes("dist") && (text.includes("manifest") || text.includes("Manifest")), `${file} must document the dist manifest/runtime boundary`);
}
const esmPlan = read("docs/bridge-esm-bundler-plan.md");
assert(esmPlan.includes("esm-import-graph") && esmPlan.includes("TODO 199"), "bridge ESM plan must document the active import-graph service worker mode");
assert(esmPlan.includes("TODO 188-193") && esmPlan.includes("TODO 197") && esmPlan.includes("TODO 198") && esmPlan.includes("TODO 199"), "bridge ESM plan must separate first-phase runtime migration, foundation, command, and startup ESM gates");
assert(read("README.md").includes("esm-import-graph"), "README must expose the current service worker build mode");

console.log("bridge build contract ok");
