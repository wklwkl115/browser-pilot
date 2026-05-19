import { readFileSync, existsSync, readdirSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bridge = path.join(root, "bridge", "pi_browser_bridge");

function read(rel) {
	return readFileSync(path.isAbsolute(rel) ? rel : path.join(root, rel), "utf8");
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

const requiredBridgeFiles = [
	"manifest.json",
	"background.js",
	"protocol.js",
	"cdp.js",
	"runtime.js",
	"wait.js",
	"network.js",
	"hook.js",
	"evidence.js",
	"frame.js",
	"html.js",
	"screenshot.js",
	"transfer.js",
	"bridge_info.js",
	"core_commands.js",
	"exec.js",
	"router.js",
	"tab_sync.js",
	"transport.js",
	"hook_dispatcher.js",
	"content.js",
	"config.js",
	"disable_dialogs.js",
	"popup.html",
	"popup.js",
	"native_command_schema.json",
];

for (const file of requiredBridgeFiles) {
	assert(existsSync(path.join(bridge, file)), `missing bridge file: ${file}`);
}

const pkg = JSON.parse(read("package.json"));
assert(pkg.version === "0.3.0", "package version must be 0.3.0");
assert(pkg.keywords?.includes("pi-package"), "package must declare pi-package keyword");
assert(pkg.pi?.extensions?.includes("./index.ts"), "package pi manifest must expose index.ts");
assert(pkg.scripts?.["sync:protocol"] === "node scripts/sync-native-protocol.mjs", "package must expose protocol sync script");
assert(pkg.scripts?.["sync:config"] === "node scripts/sync-bridge-config.mjs", "package must expose bridge config sync script");

const manifest = JSON.parse(read("bridge/pi_browser_bridge/manifest.json"));
assert(manifest.name === "Pi Native Browser Bridge", "manifest name must be Pi Native Browser Bridge");
assert(manifest.version === "0.3.0", "manifest version must be 0.3.0");
assert(manifest.background?.service_worker === "background.js", "manifest must use background.js service worker");
assert(manifest.permissions?.includes("downloads"), "manifest must include downloads permission for stable download paths");
assert(manifest.permissions?.includes("webNavigation"), "manifest must include webNavigation permission for wait.navigation event completion");

const background = read("bridge/pi_browser_bridge/background.js");
const transport = read("bridge/pi_browser_bridge/transport.js");
const bridgeInfo = read("bridge/pi_browser_bridge/bridge_info.js");
const router = read("bridge/pi_browser_bridge/router.js");
const htmlBridge = read("bridge/pi_browser_bridge/html.js");
const cdpBridge = read("bridge/pi_browser_bridge/cdp.js");
const frameBridge = read("bridge/pi_browser_bridge/frame.js");
assert(bridgeInfo.includes("manifest.version_name || manifest.version"), "bridge_info must report display version_name when available");
assert(htmlBridge.includes("raw: 'outer'") && htmlBridge.includes("fragment: 'inner'"), "html.get must implement documented raw/fragment mode aliases");
assert(cdpBridge.includes("grantUniversalAccess: Boolean(options?.grantUniversalAccess)") && !cdpBridge.includes("grantUniveralAccess"), "frame.evaluate must pass correctly-spelled CDP grantUniversalAccess option");
assert(frameBridge.includes("msg.grantUniversalAccess") && frameBridge.includes("options.grantUniversalAccess"), "frame.evaluate must forward top-level grantUniversalAccess to CDP options");
for (const file of ["config.js", "protocol.js", "cdp.js", "runtime.js", "wait.js", "network.js", "hook.js", "evidence.js", "frame.js", "html.js", "screenshot.js", "transfer.js", "bridge_info.js", "core_commands.js", "exec.js", "router.js", "tab_sync.js", "transport.js"]) {
	assert(background.includes(file), `background.js must import ${file}`);
}
assert(background.indexOf("config.js") < background.indexOf("transport.js"), "background.js must load config.js before transport.js");
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

for (const file of requiredBridgeFiles.filter((item) => item.endsWith(".js"))) {
	const text = read(`bridge/pi_browser_bridge/${file}`);
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
for (const domain of ["core", "wait", "network", "hook", "frame", "html", "screenshot", "evidence", "transfer"]) {
	assert(Array.isArray(schema.domains?.[domain]), `schema missing native domain: ${domain}`);
}
assert(schema.commands && typeof schema.commands === "object", "schema must define command specs");
for (const command of Object.values(schema.domains).flat()) {
	assert(schema.commands[command], `schema domains command missing spec: ${command}`);
}
const protocolSandbox = { self: {} };
vm.runInNewContext(read("bridge/pi_browser_bridge/protocol.js"), protocolSandbox, { filename: "protocol.js" });
assert(JSON.stringify(protocolSandbox.self.PiNativeProtocol?.schema) === JSON.stringify(schema), "protocol.js must embed generated root schema");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "wait.selector", tabId: 1, selector: "body" })?.ok === true, "protocol validator must accept valid native commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "missing.command" })?.ok === false, "protocol validator must reject unknown commands");
const runtime = read("bridge/pi_browser_bridge/runtime.js");
assert(runtime.includes("PI_BROWSER_PROTOCOL.nativeCommandMap"), "runtime native command map must come from protocol schema");
assert(router.includes("validatePiBridgeProtocolMessage"), "router must validate commands through protocol schema");
assert(transport.includes("PI_BROWSER_BRIDGE_WS_URL") && transport.includes("PI_BROWSER_BRIDGE_HTTP_URL") && !transport.includes("127.0.0.1:18765"), "transport.js must read generated bridge URLs instead of hardcoding the port");
assert(transport.split(/\r?\n/).length <= 150, "transport.js must stay focused on WebSocket lifecycle");
for (const forbidden of ["handleCookies", "handleBatch", "handleCDP", "handleTabsCommand", "chrome.scripting.executeScript", "validatePiBridgeProtocolMessage"]) {
	assert(!transport.includes(forbidden), `transport.js must not own command business logic: ${forbidden}`);
}

async function testRouterNativeWsErrorFrames() {
	const sent = [];
	const routerSandbox = {
		self: { PiNativeProtocol: { validateCommand: (msg) => ({ ok: true, command: msg }) } },
		chrome: { runtime: { onMessage: { addListener() {} } } },
		bridgeError: (_code, error, details) => ({ ok: false, error, details }),
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
assert(!serverSource.includes("sendCommand(command: Record<string, unknown>"), "server sendCommand must not accept free-form Record commands");

const registerToolsSource = read("src/tools/registerTools.ts");
const toolSource = readToolSources();
assert(registerToolsSource.split(/\r?\n/).length <= 45, "registerTools.ts must stay a thin composition entrypoint");
assert(!registerToolsSource.includes("registerTool({"), "registerTools.ts must not directly register individual tools");
assert(!registerToolsSource.includes("waitCommandForAction"), "registerTools.ts must not own domain action mapping");
for (const name of ["browser_tabs", "browser_execute", "browser_scan", "browser_pick", "browser_content", "browser_download", "browser_upload", "browser_wait", "browser_network", "browser_hook", "browser_evidence", "browser_frame", "browser_html", "browser_screenshot", "browser_artifact"]) {
	assert(toolSource.includes(`name: "${name}"`), `tool not registered: ${name}`);
}
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type"]) {
	assert(!toolSource.includes(`name: "${removed}"`), `removed split action tool must not be registered: ${removed}`);
}
assert(!toolSource.includes("PI_BROWSER_ENABLE_COMPAT_PRO"), "browser_pro compatibility gate must be removed");
assert(!toolSource.includes("name: \"browser_pro\""), "browser_pro tool must be removed");
assert(toolSource.includes("selectBrowser"), "browser selection action missing");
assert(read("src/tools/registerScanTool.ts").includes("distilledTextResult"), "browser_scan must use result distillation middleware");
assert(read("src/tools/registerHtmlTool.ts").includes("distilledTextResult"), "browser_html must use result distillation middleware");
assert(read("src/tools/registerContentTool.ts").includes("distilledTextResult"), "browser_content must use result distillation middleware");
assert(read("src/tools/registerPickTool.ts").includes("distilledJsonResult"), "browser_pick must use result distillation middleware");
assert(read("src/tools/registerEvidenceTool.ts").includes("distilledJsonResult"), "browser_evidence must use result distillation middleware");
assert(read("src/tools/registerNativeActionTools.ts").includes("distilledJsonResult"), "browser_network must use result distillation middleware through native action tools");
assert(read("src/tools/resultMiddleware.ts").includes("./summaries/index"), "result middleware must use split summary modules");
assert(toolSource.includes("For automation, call browser_tabs list or switch first"), "tab-scoped tools must warn agents to list/switch before automation");
assert(toolSource.includes("omitted tabId uses the mutable selected/active tab fallback"), "tabId fallback warning missing from tool prompts");
assert((toolSource.match(/TAB_SCOPED_TOOL_GUIDELINE/g) || []).length >= 6, "tab-scoped tools must reuse explicit tabId guidance");
assert((toolSource.match(/optionalTargetTabId\(/g) || []).length >= 6, "tab-scoped tabId parameters must reuse explicit fallback warning helper");
const skill = read("D:/Pi/agent/skills/pi-browser-tools/SKILL.md");
assert(skill.includes("tabId") && skill.includes("browser_tabs list"), "pi-browser-tools skill must document explicit tabId automation flow");
assert(skill.includes("browser_pick") && skill.includes("browser_content"), "pi-browser-tools skill must document pick/content flows");
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
assert(toolSource.includes("outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION }))"), "scan output path option missing");

async function testCdpAliasReleaseAndFrameOptions() {
	const attachedTabs = new Set();
	const sendCalls = [];
	let detachCount = 0;
	const sandbox = {
		self: {},
		console,
		setTimeout,
		clearTimeout,
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
	vm.runInNewContext(read("bridge/pi_browser_bridge/cdp.js"), sandbox, { filename: "cdp.js" });
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

console.log("pi browser bridge contract ok");
