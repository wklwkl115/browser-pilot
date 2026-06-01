import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const runtimeSrc = read("src/abml/verbs/streamRuntime.ts");
assert(runtimeSrc.includes("inspectPayloadHandle"), "stream runtime must expose inspectPayloadHandle");
assert(runtimeSrc.includes("readBrowserResultResource"), "inspect(ref) must read payload handles through the MCP resource reader");
assert(runtimeSrc.includes("replayInputFromNetworkRef"), "stream runtime must expose replay input adapter for network-entry refs");
assert(runtimeSrc.includes("createCaptureRefFromLifecycle"), "stream runtime must expose lifecycle -> CaptureRef adapter");
assert(runtimeSrc.includes("eventOrSignalEntitiesFromEvidenceBundle"), "stream runtime must convert evidence bundles into event entities");

const replayRegister = read("src/tools/webSecurity/register/registerHttpReplay.ts");
assert(replayRegister.includes('name: "browser_http_replay"'), "http replay tool must remain the replay execution boundary for now");

console.log("abml stream runtime ok");
