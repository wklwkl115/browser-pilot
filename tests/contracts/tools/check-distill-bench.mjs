import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stableJson } from "../../../src/utils/json.ts";
import { distilledJsonResult } from "../../../src/tools/resultMiddleware.ts";
import { allocateFacts } from "../../../src/distill-core/allocate.ts";
import { renderFacts } from "../../../src/distill-core/render.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const summaryPath = path.join(root, ".pi", "browser-artifacts", "distill-bench-summary.json");
const ctxDir = mkdtempSync(path.join(tmpdir(), "distill-bench-"));

const fixtures = [
	{ id: "cjk-list", tool: "browser_observe", command: "scan", value: { title: "中文列表页", rows: Array.from({ length: 80 }, (_, i) => ({ name: `项目${i}`, price: `¥${i}.00`, action: "购买" })) } },
	{ id: "form-heavy", tool: "browser_observe", command: "scan", value: { actionables: Array.from({ length: 60 }, (_, i) => ({ selector: `#field-${i}`, role: i % 4 ? "textbox" : "button", text: `Field ${i}` })) } },
	{ id: "network", tool: "browser_network", command: "network.list", value: { entries: Array.from({ length: 120 }, (_, i) => ({ requestId: String(i), url: `https://api.example.test/${i}`, status: i % 9 === 0 ? 500 : 200 })) } },
	{ id: "hook", tool: "browser_hook", command: "hook.collect", value: { events: Array.from({ length: 80 }, (_, i) => ({ seq: i, type: i % 2 ? "console" : "domSink", message: `event ${i}` })) } },
	{ id: "web-security", tool: "browser_http_replay", command: "http.replay", value: { ok: true, requestCount: 80, steps: Array.from({ length: 80 }, (_, i) => ({ index: i, request: { method: "POST", url: `/api/${i}`, headers: { "x-case": `case-${i}` }, bodyPreview: "field=value&".repeat(30) }, response: { status: i % 3 ? 200 : 403, body: { bytes: 1000 + i, text: "response body ".repeat(80) } }, delta: i % 3 ? "none" : "status" })) } }, 
];

const results = [];
for (const fixture of fixtures) {
	const rawChars = stableJson(fixture.value).length;
	const result = await distilledJsonResult(fixture.value, {
		toolName: fixture.tool,
		command: fixture.command,
		maxChars: 8_000,
		fallbackName: `${fixture.id}.json`,
		detailLevel: "summary",
		ctx: { cwd: ctxDir },
	});
	const envelope = JSON.parse(result.content[0].text);
	const envelopeChars = stableJson(envelope).length;
	const summaryChars = stableJson(envelope.summary).length;
	assert(summaryChars < rawChars, `${fixture.id}: distilled summary must be smaller than raw`);
	results.push({ id: fixture.id, rawChars, summaryChars, envelopeChars, saved: envelope.saved != null });
}

const facts = [
	{ ref: "pi-ref://bench/a", plane: "entity", salience: { actionability: 100 }, renderings: { compact: { value: { ref: "a" }, cost: 12 }, ref: { text: "a", cost: 1 } } },
	{ ref: "pi-ref://bench/b", plane: "causal", salience: { consequence: 80 }, renderings: { compact: { value: { ref: "b" }, cost: 12 }, ref: { text: "b", cost: 1 } } },
];
const plan = allocateFacts(facts, 13, [{ plane: "causal", minFacts: 1, minGranularity: "compact" }]);
const rendered = renderFacts(facts, plan);
assert.equal(plan.get("pi-ref://bench/b"), "compact", "allocator decisions must be bench-visible");
assert.ok(Array.isArray(rendered.causal), "renderer output must group facts by plane");

const summary = { ok: true, fixtures: results, allocator: Object.fromEntries(plan), rendered };
mkdirSync(path.dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`distill bench ok — fixtures=${results.length}, summary=${summaryPath}`);
