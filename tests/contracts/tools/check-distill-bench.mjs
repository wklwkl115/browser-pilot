import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { stableJson } from "../../../src/utils/json.ts";
import { distilledJsonResult } from "../../../src/tools/resultMiddleware.ts";
import { allocateFacts } from "../../../src/distill-core/allocate.ts";
import { renderFacts } from "../../../src/distill-core/render.ts";
import { countDistillTruncationMarkers } from "../../../src/distill-core/salienceEnvelope.ts";

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

function textOf(result) {
	return result.content[0].text;
}

async function runFixture(fixture, renderer) {
	const previous = process.env.PI_BROWSER_RENDERER;
	try {
		if (renderer === "salience") process.env.PI_BROWSER_RENDERER = "salience";
		else delete process.env.PI_BROWSER_RENDERER;
		const result = await distilledJsonResult(fixture.value, {
			toolName: fixture.tool,
			command: fixture.command,
			maxChars: 8_000,
			fallbackName: `${fixture.id}-${renderer}.json`,
			detailLevel: "summary",
			ctx: { cwd: ctxDir },
		});
		const text = textOf(result);
		const envelope = JSON.parse(text);
		return {
			envelope,
			chars: stableJson(envelope).length,
			summaryChars: stableJson(envelope.summary).length,
			factsCovered: ["entities", "gist", "outline", "relations", "diff", "causal", "treeDiff", "snapshotProjection"].filter((key) => envelope[key] !== undefined).length,
			truncationMarkers: countDistillTruncationMarkers(envelope),
			saved: envelope.saved != null,
		};
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_RENDERER;
		else process.env.PI_BROWSER_RENDERER = previous;
	}
}

const results = [];
for (const fixture of fixtures) {
	const rawChars = stableJson(fixture.value).length;
	const ladder = await runFixture(fixture, "ladder");
	const salience = await runFixture(fixture, "salience");
	assert(ladder.summaryChars < rawChars, `${fixture.id}: ladder summary must be smaller than raw`);
	assert(salience.summaryChars < rawChars, `${fixture.id}: salience summary must be smaller than raw`);
	assert(salience.chars <= Math.ceil(ladder.chars * 1.05), `${fixture.id}: salience chars ${salience.chars} must stay <= 1.05x ladder ${ladder.chars}`);
	assert(salience.factsCovered >= ladder.factsCovered, `${fixture.id}: salience facts ${salience.factsCovered} must cover >= ladder ${ladder.factsCovered}`);
	assert(salience.truncationMarkers <= ladder.truncationMarkers, `${fixture.id}: salience truncation markers ${salience.truncationMarkers} must stay <= ladder ${ladder.truncationMarkers}`);
	results.push({ id: fixture.id, rawChars, ladder, salience, ratios: { salienceToLadderChars: Number((salience.chars / Math.max(1, ladder.chars)).toFixed(4)) } });
}

const facts = [
	{ ref: "pi-ref://bench/a", plane: "entity", salience: { actionability: 100 }, renderings: { compact: { value: { ref: "a" }, cost: 12 }, ref: { text: "a", cost: 1 } } },
	{ ref: "pi-ref://bench/b", plane: "causal", salience: { consequence: 80 }, renderings: { compact: { value: { ref: "b" }, cost: 12 }, ref: { text: "b", cost: 1 } } },
	{ ref: "pi-ref://bench/c", plane: "entity", salience: { actionability: 1 }, renderings: { compact: { value: { ref: "c" }, cost: 120 }, ref: { text: "c", cost: 1 } } },
];
const plan = allocateFacts(facts, 133, [{ plane: "causal", minFacts: 1, minGranularity: "compact" }], { minDensity: 0.05 });
const rendered = renderFacts(facts, plan);
assert.equal(plan.get("pi-ref://bench/b"), "compact", "allocator decisions must be bench-visible");
assert.equal(plan.get("pi-ref://bench/c"), "omit", "marginal-utility stop must be bench-visible");
assert.ok(Array.isArray(rendered.causal), "renderer output must group facts by plane");
assert.equal(rendered.stats?.factsRendered, 2, "renderer stats must report rendered facts");

const summary = { ok: true, gate: { maxSalienceToLadderChars: 1.05, factsCoveredAtLeastLadder: true, truncationMarkersNoMoreThanLadder: true }, fixtures: results, allocator: Object.fromEntries(plan), rendered };
mkdirSync(path.dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`distill bench ok — fixtures=${results.length}, summary=${summaryPath}`);
