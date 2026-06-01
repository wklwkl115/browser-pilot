import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const streamSrc = read("src/abml/stream.ts");
assert(streamSrc.includes("kind: \"network-entry\""), "stream plane must model network-entry entities");
assert(streamSrc.includes("kind: \"event\""), "stream plane must model event entities");
assert(streamSrc.includes("payloadHandle"), "stream plane entities must preserve payloadHandle for large evidence");
assert(streamSrc.includes("createCaptureRef"), "stream plane must define CaptureRef lifecycle adapter");

const networkSummary = read("src/tools/summaries/network.ts");
assert(networkSummary.includes('kind: "network-entry"'), "network summary artifact hints must preserve network-entry kind for stream entities");
assert(networkSummary.includes('kind: "http-request"'), "network summary must preserve per-request replay handles");

const evidenceSummary = read("src/tools/summaries/evidence.ts");
assert(evidenceSummary.includes('kind: "evidence"'), "evidence summary must keep evidence layer-1 handles for stream reads");

console.log("abml stream plane ok");
