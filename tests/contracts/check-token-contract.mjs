import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonResult, textResult } from "../../src/utils/toolResult.ts";
import { distilledJsonResult } from "../../src/tools/resultMiddleware.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.isAbsolute(rel) ? rel : path.join(root, rel), "utf8");

const large = "x".repeat(20_000);
const json = jsonResult({ payload: large }, { command: "token-test" }, 1_000);
assert.equal(Object.hasOwn(json.details || {}, "result"), false, "check-token jsonResult.details.result: details must not duplicate full result");
assert.ok(json.content[0].text.length < 1_500, `check-token jsonResult.content length: expected <1500 got ${json.content[0].text.length}`);

const text = textResult("ok", { scan: { content: large }, items: Array.from({ length: 100 }, (_, i) => ({ i, value: large })) });
const detailsText = JSON.stringify(text.details);
assert.ok(detailsText.length < 20_000, `check-token textResult.details length: expected <20000 got ${detailsText.length}`);
assert.equal(detailsText.includes("x".repeat(2_000)), false, "check-token textResult.details large string: details must not contain unbounded large strings");
assert.ok(detailsText.includes("truncatedItems"), "check-token textResult.details.items: details must report truncated arrays");

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-browser-token-"));
try {
	const outputPath = path.join(tmp, "network.json");
	const networkPayload = { items: Array.from({ length: 80 }, (_, i) => ({ requestId: String(i), url: `https://h${i % 3}.test/r${i}`, method: "GET", status: i % 10 === 0 ? 500 : 200 })) };
	const distilled = await distilledJsonResult({ data: networkPayload }, {
		toolName: "browser_network",
		command: "network.list",
		detailLevel: "summary",
		maxChars: 2_000,
		ctx: { cwd: tmp },
		outputPath,
		fallbackName: "network.json",
		artifactValue: networkPayload,
	});
	const distilledText = distilled.content[0].text;
	assert.ok(existsSync(outputPath), `check-token distilledJsonResult.outputPath: artifact missing at ${outputPath}`);
	assert.ok(distilledText.includes('"detailLevel": "summary"'), "check-token distilledJsonResult.detailLevel: summary envelope missing");
	assert.equal(distilledText.includes("requestId".repeat(20)), false, "check-token distilledJsonResult.rawPayload: repeated raw payload leaked");
} finally {
	await rm(tmp, { recursive: true, force: true });
}

const compactSummary = await distilledJsonResult({ data: { ok: true } }, {
	toolName: "browser_execute",
	command: "dom.snapshot",
	detailLevel: "summary",
	maxChars: 4_000,
	ctx: { cwd: tmp },
	fallbackName: "summary-budget.json",
	distill: () => ({
		snapshotId: "s",
		textPreview: "z".repeat(5_000),
		rows: { columns: ["id", "label"], rows: Array.from({ length: 80 }, (_, i) => [`r${i}`, "row label ".repeat(20)]), count: 80 },
	}),
});
const compactEnvelope = JSON.parse(compactSummary.content[0].text);
assert.ok(compactSummary.content[0].text.length < 4_500, "check-token summaryBudget.length: summary must fit the requested response budget");
assert.equal(compactSummary.content[0].text.includes("z".repeat(1_000)), false, "check-token summaryBudget.text: low-value long previews must be trimmed or omitted");
assert.ok(!compactEnvelope.summary.rows || compactEnvelope.summary.rows.rows.length < 80, "check-token summaryBudget.table: compact tables must not return all rows under summary budget");

const toolResultSource = read("src/utils/toolResult.ts");
assert.equal(toolResultSource.includes("result: value"), false, "toolResult must not add full result into details");
assert.ok(read("src/tools/resultMiddleware.ts").includes("fitSummaryBudget"), "result middleware must apply deterministic summary budget allocation");
assert.ok(read("src/tools/summaries/common.ts").includes("summaryTable"), "summary modules must support columns+rows compact tables");
assert.ok(read("D:/Pi/agent/skills/pi-browser-tools/SKILL.md").includes("detailLevel"), "pi-browser-tools skill must document detailLevel behavior");

console.log("token contract ok");
