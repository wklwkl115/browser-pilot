import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const stripBridgeSource = (text) => text
	.replace(/^\/\/ @ts-nocheck\r?\n/, "")
	.replace(/^import\s+[^;]+;\r?\n/gm, "")
	.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
	.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
	.replace(/\s+as\s+any/g, "")
	.replace(/\r?\n\/\/ ESM module boundary marker for TODO 189\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
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
for (const domain of ["core", "wait", "network", "hook", "frame", "html", "screenshot", "evidence", "transfer"]) assert(Array.isArray(schema.domains?.[domain]), `schema missing native domain: ${domain}`);
assert(schema.commands && typeof schema.commands === "object", "schema must define command specs");
for (const command of Object.values(schema.domains).flat()) assert(schema.commands[command], `schema domains command missing spec: ${command}`);
assert(schema.commands.cookies?.methods?.includes("set") && schema.commands.cookies?.methods?.includes("remove"), "schema must expose cookies set/remove methods for orchestration primitives");
assert(schema.commands.cookies?.methodSpecs?.set?.required?.includes("value") && schema.commands.cookies?.methodSpecs?.set?.allowEmptyRequired?.includes("value") && schema.commands.cookies?.methodSpecs?.remove?.required?.includes("name"), "schema must validate required fields for cookies set/remove while allowing empty cookie values");
const nativeCommandSpecText = JSON.stringify(schema.commands);
for (const logicalTargetField of ["target", "sessionTag", "tabRole", "orchestrationId", "profileId", "groupId", "requireOwned"]) {
	assert(!nativeCommandSpecText.includes(`\"${logicalTargetField}\"`), `native command schema must not expose tool-level logical target field: ${logicalTargetField}`);
}
assert(schema.domains.core?.includes("windows") && schema.commands.windows?.methods?.includes("create") && schema.commands.windows?.methodSpecs?.close?.required?.includes("windowId"), "schema must expose TODO 226 windows native primitives with windowId validation");
assert(schema.domains.core?.includes("tabGroups") && schema.commands.tabGroups?.methods?.includes("status") && schema.commands.tabGroups?.methodSpecs?.group?.required?.includes("tabIds") && schema.commands.tabGroups?.methodSpecs?.update?.required?.includes("tabGroupId"), "schema must expose TODO 226 tabGroups native primitives with group/update validation");
assert(schema.errorCodes?.WINDOW_ID_REQUIRED?.category === "runtime.window" && schema.errorCodes?.TAB_GROUPS_NOT_SUPPORTED?.category === "runtime.tabGroups" && schema.errorCodes?.ORCHESTRATION_WINDOW_OWNERSHIP_REQUIRED?.category === "driver.orchestration", "schema must expose TODO 226 window/tabGroups error taxonomy");
assert(schema.toolMetadata?.nativeActionTools?.browser_wait?.actions?.some((item) => item.command === "wait.selector"), "schema must define browser_wait action metadata");
assert(schema.toolMetadata?.nativeActionTools?.browser_network?.actions?.some((item) => item.command === "network.exportHar"), "schema must define browser_network action metadata");
assert(schema.toolMetadata?.transferTools?.browser_download?.command === "transfer.download", "schema must define browser_download transfer metadata");
assert(schema.toolMetadata?.transferTools?.browser_upload?.command === "transfer.upload", "schema must define browser_upload transfer metadata");
assert(schema.errorCodes?.TAB_NOT_FOUND?.category === "driver.tab" && schema.errorCodes?.UPLOAD_REQUIRES_BROWSER_UPLOAD?.category === "tool.transfer", "schema must define generated error taxonomy");

const protocolSandbox = { self: {} };
vm.runInNewContext(transformBridgeSourceForVm(readServiceWorkerSource("protocol"), "bridge_src/service_worker/protocol.ts"), protocolSandbox, { filename: "protocol.js" });
assert(JSON.stringify(protocolSandbox.self.PiNativeProtocol?.schema) === JSON.stringify(schema), "protocol.js must embed generated root schema");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "wait.selector", tabId: 1, selector: "body" })?.ok === true, "protocol validator must accept valid native commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "transfer.download", tabId: 1, selector: "a[download]" })?.ok === true, "protocol validator must accept transfer commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "cookies", method: "set", url: "https://example.test", name: "sid", value: "abc" })?.ok === true, "protocol validator must accept cookies.set with required fields");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "cookies", method: "set", url: "https://example.test", name: "sid", value: "" })?.ok === true, "protocol validator must accept empty cookie values for cookies.set");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "cookies", method: "set", url: "https://example.test", name: "sid" })?.ok === false, "protocol validator must reject cookies.set without value");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "windows", method: "create", url: "https://example.test" })?.ok === true, "protocol validator must accept windows.create without tabId");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "windows", method: "close", windowId: 1 })?.ok === true, "protocol validator must accept windows.close with windowId");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "windows", method: "close" })?.ok === false, "protocol validator must reject windows.close without windowId");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "tabGroups", method: "status" })?.ok === true, "protocol validator must accept tabGroups.status without tabId");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "tabGroups", method: "group", tabIds: [1, 2] })?.ok === true, "protocol validator must accept tabGroups.group with tabIds");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "tabGroups", method: "update", tabGroupId: 1 })?.ok === true, "protocol validator must accept tabGroups.update with tabGroupId");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "tabGroups", method: "update", groupId: 1 })?.ok === false, "protocol validator must keep native tabGroups field distinct from logical target.groupId");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "wait.selector", tabId: 1, selector: "" })?.ok === false, "protocol validator must still reject empty required fields for normal commands");
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
assert(errorCodesSource.includes('"TAB_NOT_FOUND"') && errorCodesSource.includes('"UPLOAD_REQUIRES_BROWSER_UPLOAD"'), "native error codes must be generated from schema");
assert(protocolDoc.includes("## Native commands") && protocolDoc.includes("## Tool metadata slice") && protocolDoc.includes("## Error codes") && protocolDoc.includes("README snippet"), "native protocol generated docs must include command/tool/error/doc sections");
const actionCommands = read("src/tools/actionCommands.ts");
assert(actionCommands.includes("commandForNativeToolAction") && !actionCommands.includes('waitforselector: "wait.selector"') && !actionCommands.includes('exporthar: "network.exportHar"'), "wait/network action mapping must come from generated metadata");
assert(read("src/tools/registerNativeActionTools.ts").includes("nativeToolMetadata.nativeActionTools.browser_wait.actionDescription"), "native action tool descriptions must consume generated metadata");
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
assert(pkg.scripts?.["check:protocol"] === "node scripts/sync-native-protocol.mjs --check && node tests/contracts/check-protocol-contract.mjs", "check:protocol must run generated protocol drift check before contracts");
console.log("protocol contract ok");
