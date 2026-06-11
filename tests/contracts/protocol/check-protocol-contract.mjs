import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const stripBridgeSource = (text) => text
	.replace(/^\/\/ @ts-nocheck\r?\n/, "")
	.replace(/^import\s+[^;]+;\r?\n/gm, "")
	.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
	.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
	.replace(/\s+as\s+any/g, "")
	.replace(/\r?\n\/\/ ESM module metadata\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
	.replace(/\r?\nexport \{\};\s*$/, "");
const readServiceWorkerSource = (name) => stripBridgeSource(read(`bridge_src/service_worker/${name}.ts`));
const transformBridgeSourceForVm = (text, sourcefile) => transformSync(text, { loader: "ts", target: "chrome120", sourcefile }).code;
function assert(condition, message) { if (!condition) throw new Error(message); }
function walk(rel, predicate = () => true) {
	const dir = path.join(root, rel);
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = path.join(rel, entry.name).replace(/\\/g, "/");
		if (entry.isDirectory()) out.push(...walk(child, predicate));
		else if (predicate(child)) out.push(child);
	}
	return out;
}

execFileSync(process.execPath, ["scripts/sync-native-protocol.mjs", "--check"], { cwd: root, stdio: "pipe" });

const rootSchemaText = read("bridge/native_command_schema.json");
const bridgeSchemaText = read("bridge/pi_browser_bridge/native_command_schema.json");
const rootSchema = JSON.parse(rootSchemaText);
const schema = JSON.parse(bridgeSchemaText);
assert(JSON.stringify(schema) === JSON.stringify(rootSchema), "bridge native_command_schema.json must be generated from root schema");
for (const domain of ["core", "wait", "network", "intercept", "hook", "frame", "html", "screenshot", "evidence", "transfer", "ws"]) assert(Array.isArray(schema.domains?.[domain]), `schema missing native domain: ${domain}`);
assert(schema.commands && typeof schema.commands === "object", "schema must define command specs");
for (const command of Object.values(schema.domains).flat()) assert(schema.commands[command], `schema domains command missing spec: ${command}`);
for (const [name, spec] of Object.entries(schema.commands)) {
	const commandSpec = spec;
	if (commandSpec.accessMode !== undefined) assert(["read", "write"].includes(commandSpec.accessMode), `schema accessMode must be read|write: ${name}`);
	if (commandSpec.methodSpecs && typeof commandSpec.methodSpecs === "object") {
		for (const [method, methodSpec] of Object.entries(commandSpec.methodSpecs)) {
			if (methodSpec && typeof methodSpec === "object" && methodSpec.accessMode !== undefined) assert(["read", "write"].includes(methodSpec.accessMode), `schema method accessMode must be read|write: ${name}.${method}`);
		}
	}
}
assert(schema.toolMetadata?.nativeActionTools?.browser_wait?.actions?.some((item) => item.command === "wait.selector"), "schema must define browser_wait action metadata");
assert(schema.toolMetadata?.nativeActionTools?.browser_network?.actions?.some((item) => item.command === "network.exportHar"), "schema must define browser_network action metadata");
assert(schema.toolMetadata?.nativeActionTools?.browser_hook?.actions?.some((item) => item.command === "hook.install_targets"), "schema must define browser_hook action metadata");
assert(schema.toolMetadata?.nativeActionTools?.browser_frame?.actions?.some((item) => item.command === "frame.addNewDocumentScript"), "schema must define browser_frame action metadata");
assert(schema.toolMetadata?.nativeCommandTools?.browser_evidence?.command === "evidence.collect", "schema must define browser_evidence command metadata");
assert(schema.toolMetadata?.nativeCommandTools?.browser_screenshot?.command === "screenshot.capture", "schema must define browser_screenshot command metadata");
assert(schema.toolMetadata?.nativeCommandTools?.browser_observe_html?.command === "html.get", "schema must define browser_observe html command metadata");
assert(schema.toolMetadata?.transferTools?.browser_download?.command === "transfer.download", "schema must define browser_download transfer metadata");
assert(schema.toolMetadata?.transferTools?.browser_upload?.command === "transfer.upload", "schema must define browser_upload transfer metadata");
assert(schema.errorCodes?.TAB_NOT_FOUND?.category === "driver.tab" && schema.errorCodes?.UPLOAD_REQUIRES_BROWSER_UPLOAD?.category === "tool.transfer", "schema must define generated error taxonomy");
assert(schema.errorCodes?.MATURE_BRIDGE_LAUNCHER_NOT_FOUND?.category === "tool.security" && schema.errorCodes?.MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED?.category === "tool.security", "schema must define mature bridge diagnostic error taxonomy");
assert(schema.errorCodes?.WEBSOCKET_SESSION_NOT_FOUND?.category === "bridge.ws" && schema.errorCodes?.WEBSOCKET_WAIT_TIMEOUT?.category === "bridge.ws", "schema must define websocket diagnostic error taxonomy");
assert(schema.commands?.["content.fingerprint"]?.internal === true && schema.commands?.["content.fingerprint"]?.tabScoped === true && schema.commands?.["content.fingerprint"]?.accessMode === "read", "schema must keep content.fingerprint as an internal tab-scoped read command for effect collection");

const protocolSandbox = { self: {} };
vm.runInNewContext(transformBridgeSourceForVm(readServiceWorkerSource("protocol"), "bridge_src/service_worker/protocol.ts"), protocolSandbox, { filename: "protocol.js" });
assert(JSON.stringify(protocolSandbox.self.PiNativeProtocol?.schema) === JSON.stringify(schema), "protocol.js must embed generated root schema");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "wait.selector", tabId: 1, selector: "body" })?.ok === true, "protocol validator must accept valid native commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "transfer.download", tabId: 1, selector: "a[download]" })?.ok === true, "protocol validator must accept transfer commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "content.fingerprint", tabId: 1 })?.ok === true, "protocol validator must accept internal content.fingerprint for driver-owned signal reads");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "content.fingerprint" }, { allowMissingTabId: false })?.ok === false, "content.fingerprint must remain tab-scoped");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "missing.command" })?.ok === false, "protocol validator must reject unknown commands");

const runtime = readServiceWorkerSource("runtime");
const router = readServiceWorkerSource("router");
assert(runtime.includes("PI_BROWSER_PROTOCOL.nativeCommandMap"), "runtime native command map must come from protocol schema");
assert(router.includes("validatePiBridgeProtocolMessage"), "router must validate commands through protocol schema");
const serverSource = read("src/driver/BrowserBridgeServer.ts");
assert(serverSource.includes("validateBridgeCommand"), "server must validate bridge commands through protocol schema");
assert(!serverSource.includes("sendCommand(command: Record<string, unknown>"), "server sendCommand must not accept free-form Record commands");
const nodeProtocolSource = read("src/protocol/nativeProtocol.ts");
const actionMetadataSource = read("src/protocol/nativeActionMetadata.ts");
const errorCodesSource = read("src/protocol/nativeErrorCodes.ts");
const protocolDoc = read("docs/generated/native-protocol.generated.md");
for (const generated of [nodeProtocolSource, actionMetadataSource, errorCodesSource, read("bridge_src/service_worker/protocol.ts")]) assert(generated.startsWith("// Generated from bridge/native_command_schema.json. Do not edit by hand."), "protocol generated source must carry generated header");
assert(!nodeProtocolSource.includes("readFileSync") && !nodeProtocolSource.includes("protocolSchemaPath"), "Node protocol validator must be generated with embedded schema, not runtime file reads");
assert(actionMetadataSource.includes('"waitforselector": "wait.selector"') && actionMetadataSource.includes('"export": "network.exportHar"'), "native action metadata must generate wait/network aliases");
assert(actionMetadataSource.includes('"installtargets": "hook.install_targets"') && actionMetadataSource.includes('"addscript": "frame.addNewDocumentScript"'), "native action metadata must generate hook/frame aliases");
assert(actionMetadataSource.includes('export const nativeCommandToolMetadata = nativeToolMetadata.nativeCommandTools;'), "native action metadata must export native command tool metadata");
assert(actionMetadataSource.includes('export function metadataForNativeCommandTool(toolName: NativeCommandToolName)') && actionMetadataSource.includes('export function metadataForNativeTransferTool(toolName: NativeTransferToolName)'), "native action metadata must export typed metadata helper accessors");
assert(errorCodesSource.includes('"TAB_NOT_FOUND"') && errorCodesSource.includes('"UPLOAD_REQUIRES_BROWSER_UPLOAD"') && errorCodesSource.includes('"MATURE_BRIDGE_LAUNCHER_NOT_FOUND"'), "native error codes must be generated from schema");
assert(protocolDoc.includes("## Native commands") && protocolDoc.includes("## Tool metadata slice") && protocolDoc.includes("## Error codes") && protocolDoc.includes("README snippet"), "native protocol generated docs must include command/tool/error/doc sections");
assert(!protocolDoc.includes("`content.fingerprint`"), "native protocol generated docs must not publish internal content.fingerprint as a user-facing native command");
assert(protocolDoc.includes("browser_frame") && protocolDoc.includes("browser_evidence") && protocolDoc.includes("browser_screenshot") && protocolDoc.includes("browser_observe_html"), "native protocol docs must include migrated hook/frame/html/screenshot/evidence tool metadata rows");
const actionCommands = read("src/tools/actionCommands.ts");
assert(actionCommands.includes("commandForNativeToolAction") && !actionCommands.includes('waitforselector: "wait.selector"') && !actionCommands.includes('exporthar: "network.exportHar"'), "wait/network action mapping must come from generated metadata");
const nativeActionToolSource = read("src/tools/registerNativeActionTools.ts");
assert(nativeActionToolSource.includes("nativeToolMetadata.nativeActionTools.browser_wait.actionDescription") && nativeActionToolSource.includes("nativeToolMetadata.nativeActionTools.browser_hook.actionDescription") && nativeActionToolSource.includes("nativeToolMetadata.nativeActionTools.browser_frame.actionDescription"), "native action tool descriptions must consume generated metadata");
assert(read("src/tools/registerEvidenceTool.ts").includes("nativeCommandToolMetadata.browser_evidence.command"), "browser_evidence must consume generated native command metadata");
assert(read("src/tools/registerScreenshotTool.ts").includes("nativeCommandToolMetadata.browser_screenshot.command"), "browser_screenshot must consume generated native command metadata");
assert(read("src/tools/observeRunners.ts").includes("nativeCommandToolMetadata.browser_observe_html.command"), "browser_observe html mode must consume generated native command metadata");
assert(read("src/tools/transferValidation.ts").includes("nativeTransferToolMetadata.browser_upload.command"), "transfer validation must consume generated command metadata");
assert(read("src/tools/registerTransferTools.ts").includes("nativeTransferToolMetadata.browser_download.artifactPrefix"), "transfer tools must consume generated artifact metadata");
const structuredCodePatterns = [
	/(?:BrowserBridgeError|tabsToolError|codedTransferError)\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
	/\berror_code\s*:\s*"([A-Z][A-Z0-9_]{2,})"/g,
	/\bcode\s*:\s*"([A-Z][A-Z0-9_]{2,})"/g,
];
const generatedProtocolFiles = new Set(["src/protocol/nativeProtocol.ts", "src/protocol/nativeErrorCodes.ts", "bridge_src/service_worker/protocol.ts"]);
for (const file of [...walk("src", (item) => item.endsWith(".ts")), ...walk("bridge_src", (item) => item.endsWith(".ts"))]) {
	if (generatedProtocolFiles.has(file)) continue;
	const text = read(file);
	for (const pattern of structuredCodePatterns) {
		for (const match of text.matchAll(pattern)) assert(schema.errorCodes?.[match[1]], `schema errorCodes missing structured code ${match[1]} from ${file}`);
	}
}
const pkg = JSON.parse(read("package.json"));
assert(pkg.scripts?.["check:protocol"] === "node scripts/sync-native-protocol.mjs --check && node tests/contracts/protocol/check-protocol-contract.mjs", "check:protocol must run generated protocol drift check before contracts");
console.log("protocol contract ok");
