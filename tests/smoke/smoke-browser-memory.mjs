import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpExtensionAdapter } from "../../mcp/adapter.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";

const cwd = await mkdtemp(path.join(os.tmpdir(), "browser-memory-smoke-"));
const outDir = path.join(cwd, ".pi", "browser-artifacts");
await mkdir(outDir, { recursive: true });
const evidencePath = path.join(outDir, "memory-evidence.json");
await writeFile(evidencePath, JSON.stringify({ ok: true, step: "memory smoke" }), "utf8");

const adapter = new McpExtensionAdapter();
const fakeBridge = {
	setCapabilityProfile() {},
	getObservationSnapshot() { return undefined; },
};
registerBrowserTools(adapter, fakeBridge, async () => fakeBridge, { securityToolsEnabled: true });
const tool = adapter.getTool("browser_memory");
if (!tool) throw new Error("browser_memory tool not registered");

const validate = await tool.execute("smoke-validate", {
	action: "validate",
	kind: "sop",
	scopeKind: "task",
	scopeKey: "web-recon",
	title: "memory smoke task",
	triggers: ["recon", "memory"],
	body: "1. open target\n2. inspect\n3. capture evidence\n",
	evidenceRefs: [evidencePath],
	maxChars: 8000,
}, undefined, undefined, { cwd, hasUI: false });
const validateJson = JSON.parse(validate.content[0].text);
if (validateJson.summary?.ok !== true || validateJson.summary?.scopeKind !== "task") throw new Error(`validate failed: ${validate.content[0].text}`);

const record = await tool.execute("smoke-record", {
	action: "record",
	kind: "sop",
	scopeKind: "task",
	scopeKey: "web-recon",
	title: "memory smoke task",
	triggers: ["recon", "memory"],
	body: "1. open target\n2. inspect\n3. capture evidence\n",
	evidenceRefs: [evidencePath],
	maxChars: 8000,
}, undefined, undefined, { cwd, hasUI: false });
const recordJson = JSON.parse(record.content[0].text);
const id = recordJson.summary?.id;
if (!id) throw new Error(`record failed: ${record.content[0].text}`);

const recall = await tool.execute("smoke-recall", {
	action: "recall",
	scopeKind: "task",
	scopeKey: "web-recon",
	query: "recon",
	maxChars: 8000,
}, undefined, undefined, { cwd, hasUI: false });
const recallJson = JSON.parse(recall.content[0].text);
if (recallJson.summary?.count < 1) throw new Error(`recall failed: ${recall.content[0].text}`);

const read = await tool.execute("smoke-read", {
	action: "read",
	id,
	mode: "text",
	offset: 1,
	limit: 5,
	maxChars: 8000,
}, undefined, undefined, { cwd, hasUI: false });
const readJson = JSON.parse(read.content[0].text);
if (readJson.summary?.mode !== "text") throw new Error(`read failed: ${read.content[0].text}`);

const indexText = await readFile(path.join(cwd, ".pi", "browser-memory", "index.json"), "utf8");
const index = JSON.parse(indexText);
if (!Array.isArray(index.entries) || !index.entries.length) throw new Error("index not written");

console.log(JSON.stringify({ ok: true, cwd, id, entryCount: index.entries.length }, null, 2));
