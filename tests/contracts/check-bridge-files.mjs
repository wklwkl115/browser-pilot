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

const waitBridgeRuntimeFiles = ["wait.js"];
const networkBridgeRuntimeFiles = ["network_model.js", "network.js"];
const serviceWorkerBridgeFiles = ["config.js", "protocol.js", "patterns.js", "cdp.js", "runtime.js", ...waitBridgeRuntimeFiles, ...networkBridgeRuntimeFiles, "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "router.js", "tab_sync.js", "transport.js"];

const requiredBridgeFiles = [
	"manifest.json", "background.js", "protocol.js", "patterns.js", "cdp.js", "runtime.js", "wait.js", "network_model.js", "network.js", "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "router.js", "tab_sync.js", "transport.js", "hook_dispatcher.js", "content.js", "config.js", "disable_dialogs.js", "popup.html", "popup.js", "native_command_schema.json",
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

const manifest = JSON.parse(read("bridge/pi_browser_bridge/manifest.json"));
assert(manifest.name === "Pi Native Browser Bridge", "manifest name must be Pi Native Browser Bridge");
assert(manifest.version === "0.3.0", "manifest version must be 0.3.0");
assert(manifest.background?.service_worker === "background.js", "manifest must use background.js service worker");
assert(manifest.permissions?.includes("downloads"), "manifest must declare downloads permission for browser_download path return");

const background = read("bridge/pi_browser_bridge/background.js");
const bridgeInfo = read("bridge/pi_browser_bridge/bridge_info.js");
const transport = read("bridge/pi_browser_bridge/transport.js");
const router = read("bridge/pi_browser_bridge/router.js");
const networkModel = read("bridge/pi_browser_bridge/network_model.js");
const networkRuntime = read("bridge/pi_browser_bridge/network.js");
assert(background.includes("@ts-check") && bridgeInfo.includes("@ts-check") && router.includes("@ts-check"), "bridge bootstrap/core entrypoints must opt into JS type checking documentation");
assert(router.includes("@param {PiBridgeCommand}") && router.includes("@param {PiBridgeWebSocketLike}"), "router must document bridge envelope/socket JSDoc types");
assert(bridgeInfo.includes("manifest.version_name || manifest.version"), "bridge_info must report display version_name when available");
for (const file of serviceWorkerBridgeFiles) assert(background.includes(file), `background.js must import ${file}`);
assertBackgroundOrder(background, serviceWorkerBridgeFiles, "background service worker script order");
assert(background.indexOf("protocol.js") < background.indexOf("runtime.js"), "background.js must load protocol.js before runtime.js");
assert(background.indexOf("protocol.js") < background.indexOf("router.js"), "background.js must load protocol.js before router.js");
assert(background.indexOf("router.js") < background.indexOf("transport.js"), "background.js must load router.js before transport.js");
assert(background.indexOf("tab_sync.js") < background.indexOf("transport.js"), "background.js must load tab_sync.js before transport.js");
assert(waitBridgeRuntimeFiles.at(-1) === "wait.js", "wait bridge runtime bundle must keep wait.js as the final facade/dispatch script");
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
assert(read("AI_INSTALL.md").includes("PI_BROWSER_BRIDGE_PORT") && read("AI_INSTALL.md").includes("/browser-status"), "AI_INSTALL.md must own environment and diagnostics instructions");
assert(readdirSync(path.join(root, "src", "tools", "summaries")).length >= 5, "summary modules must stay split");
console.log("bridge files contract ok");
