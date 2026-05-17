import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
function assert(condition, message) { if (!condition) throw new Error(message); }

const rootSchemaText = read("bridge/native_command_schema.json");
const bridgeSchemaText = read("bridge/pi_browser_bridge/native_command_schema.json");
const rootSchema = JSON.parse(rootSchemaText);
const schema = JSON.parse(bridgeSchemaText);
assert(JSON.stringify(schema) === JSON.stringify(rootSchema), "bridge native_command_schema.json must be generated from root schema");
for (const domain of ["core", "wait", "network", "hook", "frame", "html", "screenshot", "evidence", "transfer"]) assert(Array.isArray(schema.domains?.[domain]), `schema missing native domain: ${domain}`);
assert(schema.commands && typeof schema.commands === "object", "schema must define command specs");
for (const command of Object.values(schema.domains).flat()) assert(schema.commands[command], `schema domains command missing spec: ${command}`);

const protocolSandbox = { self: {} };
vm.runInNewContext(read("bridge/pi_browser_bridge/protocol.js"), protocolSandbox, { filename: "protocol.js" });
assert(JSON.stringify(protocolSandbox.self.PiNativeProtocol?.schema) === JSON.stringify(schema), "protocol.js must embed generated root schema");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "wait.selector", tabId: 1, selector: "body" })?.ok === true, "protocol validator must accept valid native commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "transfer.download", tabId: 1, selector: "a[download]" })?.ok === true, "protocol validator must accept transfer commands");
assert(protocolSandbox.self.PiNativeProtocol?.validateCommand?.({ cmd: "missing.command" })?.ok === false, "protocol validator must reject unknown commands");

const runtime = read("bridge/pi_browser_bridge/runtime.js");
const router = read("bridge/pi_browser_bridge/router.js");
assert(runtime.includes("PI_BROWSER_PROTOCOL.nativeCommandMap"), "runtime native command map must come from protocol schema");
assert(router.includes("validatePiBridgeProtocolMessage"), "router must validate commands through protocol schema");
const serverSource = read("src/driver/BrowserBridgeServer.ts");
assert(serverSource.includes("validateBridgeCommand"), "server must validate bridge commands through protocol schema");
assert(!serverSource.includes("sendCommand(command: Record<string, unknown>"), "server sendCommand must not accept free-form Record commands");
console.log("protocol contract ok");
