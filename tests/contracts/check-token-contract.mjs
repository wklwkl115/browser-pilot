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

const toolResultSource = read("src/utils/toolResult.ts");
assert.equal(toolResultSource.includes("result: value"), false, "toolResult must not add full result into details");
assert.ok(read("src/tools/resultMiddleware.ts").includes("distillValue"), "result middleware must expose deterministic distillation");
assert.ok(read("D:/Pi/agent/skills/pi-browser-tools/SKILL.md").includes("detailLevel"), "pi-browser-tools skill must document detailLevel behavior");

console.log("token contract ok");
