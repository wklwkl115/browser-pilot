import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorResult, jsonResult, textResult } from "../../../src/utils/toolResult.ts";
import { distilledJsonResult, distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function resolveReadPath(rel) {
	if (path.isAbsolute(rel)) return rel;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(rel);
	if (drivePath) return process.platform === "win32" ? rel : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, rel);
}
const read = (rel) => readFileSync(resolveReadPath(rel), "utf8");

const large = "x".repeat(20_000);
const json = jsonResult({ payload: large }, { command: "token-test" }, 1_000);
assert.equal(Object.hasOwn(json.details || {}, "result"), false, "check-token jsonResult.details.result: details must not duplicate full result");
assert.ok(json.content[0].text.length < 1_500, `check-token jsonResult.content length: expected <1500 got ${json.content[0].text.length}`);

const text = textResult("ok", { scan: { content: large }, items: Array.from({ length: 100 }, (_, i) => ({ i, value: large })) });
const detailsText = JSON.stringify(text.details);
assert.ok(detailsText.length < 20_000, `check-token textResult.details length: expected <20000 got ${detailsText.length}`);
assert.equal(detailsText.includes("x".repeat(2_000)), false, "check-token textResult.details large string: details must not contain unbounded large strings");
assert.ok(detailsText.includes("truncatedItems"), "check-token textResult.details.items: details must report truncated arrays");
const sensitiveError = new Error("Authorization: Bearer error-secret");
sensitiveError.details = { headers: { Cookie: "sid=error-cookie" }, request: { postData: "error-postdata" }, websocket: { payloadData: "error-ws" } };
const sensitiveErrorResult = errorResult(sensitiveError);
const sensitiveErrorText = JSON.stringify(sensitiveErrorResult);
for (const secret of ["error-secret", "error-cookie", "error-postdata", "error-ws"]) {
	assert.equal(sensitiveErrorText.includes(secret), false, `check-token errorResult.privacy: ${secret} must be redacted from error content and details`);
}

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
	assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), networkPayload, "check-token distilledJsonResult.outputPath: artifact must preserve the explicit artifactValue");
	assert.ok(distilledText.includes('"detailLevel": "summary"'), "check-token distilledJsonResult.detailLevel: summary envelope missing");
	assert.equal(distilledText.includes("requestId".repeat(20)), false, "check-token distilledJsonResult.rawPayload: repeated raw payload leaked");

	const preview = await distilledJsonResult({ ok: true, payload: "p".repeat(50_000) }, {
		toolName: "browser_execute",
		command: "execute.script",
		detailLevel: "preview",
		maxChars: 1_500,
		ctx: { cwd: tmp },
		fallbackName: "preview.json",
	});
	const previewEnvelope = JSON.parse(preview.content[0].text);
	assert.equal(previewEnvelope.detailLevel, "preview", "check-token distilledJsonResult.preview: preview must use the summary envelope contract");
	assert.equal(preview.content[0].text.includes("p".repeat(1_000)), false, "check-token distilledJsonResult.preview: raw payload must not leak through preview");
	assert.ok(previewEnvelope.saved?.path, "check-token distilledJsonResult.preview: oversized preview envelope must save the raw result artifact");
	assert.equal(previewEnvelope.diagnostics.warnings.includes("raw_result_saved_to_artifact"), true, "check-token distilledJsonResult.diagnostics: saved raw result must be diagnosable");
	assert.equal(previewEnvelope.limits.maxChars, 1_500, "check-token distilledJsonResult.limits: envelope must surface response budget");
	assert.equal(previewEnvelope.privacy.localOnly, true, "check-token distilledJsonResult.privacy: saved artifacts must expose local-only privacy metadata");
	assert.ok(previewEnvelope.nextActions.some((item) => item.includes("read_saved_artifact") || item.includes("read(pi-ref://") || item.includes("click(pi-ref://")), "check-token distilledJsonResult.nextActions: saved artifacts must suggest verb-style or artifact-read follow-up without leaking local paths");

	const contentOutputPath = path.join(tmp, "content.json");
	const contentArtifact = { ok: true, data: { markdown: "# T", url: "https://example.test", meta: { target: "main" } } };
	const contentResult = await distilledTextResult("# T", {
		toolName: "browser_observe",
		command: "content",
		detailLevel: "summary",
		maxChars: 1_500,
		ctx: { cwd: tmp },
		outputPath: contentOutputPath,
		fallbackName: "content.json",
		summary: { url: "https://example.test", markdownChars: 3 },
		artifactValue: contentArtifact,
	});
	assert.ok(contentResult.content[0].text.includes('"tool": "browser_observe"'), "check-token distilledTextResult.outputPath: text tools must still return the compact envelope");
	assert.deepEqual(JSON.parse(readFileSync(contentOutputPath, "utf8")), contentArtifact, "check-token distilledTextResult.outputPath: text tool artifact must preserve structured artifactValue");

	const sensitiveOutputPath = path.join(tmp, "sensitive-network.json");
	const sensitiveNetwork = {
		request: { headers: { Authorization: "Bearer summary-secret", Cookie: "sid=summary-cookie" }, postData: "summary-postdata" },
		response: { body: { text: "token=summary-body", bytes: 18 } },
		websocket: { payloadData: "summary-ws" },
	};
	const sensitiveFull = await distilledJsonResult(sensitiveNetwork, {
		toolName: "browser_network",
		command: "network.get",
		detailLevel: "full",
		maxChars: 50_000,
		ctx: { cwd: tmp },
		outputPath: sensitiveOutputPath,
		fallbackName: "sensitive-network.json",
		distill: () => ({
			headers: sensitiveNetwork.request.headers,
			postData: sensitiveNetwork.request.postData,
			body: sensitiveNetwork.response.body,
			websocket: sensitiveNetwork.websocket,
		}),
	});
	const sensitiveFullText = sensitiveFull.content[0].text;
	for (const secret of ["summary-secret", "summary-cookie", "summary-postdata", "summary-body", "summary-ws"]) {
		assert.equal(sensitiveFullText.includes(secret), false, `check-token resultMiddleware.privacy: ${secret} must not leak through summary/full output`);
	}
	assert.ok(sensitiveFullText.includes("saved_to_artifact"), "check-token resultMiddleware.privacy: sensitive full output must be represented by a saved artifact envelope");
	const sensitiveEnvelope = JSON.parse(sensitiveFullText);
	assert.ok(sensitiveFullText.includes('"redacted": true'), "check-token resultMiddleware.privacy: redaction pointers must remain visible");
	assert.ok(sensitiveFullText.includes('"kind": "authorization"') && sensitiveFullText.includes('"kind": "cookie"') && sensitiveFullText.includes('"kind": "postData"') && sensitiveFullText.includes('"kind": "body"'), "check-token resultMiddleware.privacy: pointer kinds must identify sensitive value classes");
	assert.equal(sensitiveEnvelope.summary.headers.Authorization.raw, sensitiveOutputPath, "check-token resultMiddleware.privacy: pointer must name the raw artifact path");
	assert.equal(sensitiveEnvelope.summary.headers.Authorization.jsonPath, "request.headers.Authorization", "check-token resultMiddleware.privacy: pointer must name the raw artifact jsonPath");
	assert.ok(readFileSync(sensitiveOutputPath, "utf8").includes("summary-secret"), "check-token resultMiddleware.privacy: local artifact must preserve raw evidence for explicit reads");
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

const cjkBudgetSummary = await distilledJsonResult({ data: { ok: true } }, {
	toolName: "browser_execute",
	command: "dom.snapshot",
	detailLevel: "summary",
	maxChars: 4_000,
	ctx: { cwd: tmp },
	fallbackName: "cjk-budget.json",
	distill: () => ({
		title: "中文预算页",
		textPreview: "汉字".repeat(1_200),
		rows: { columns: ["id", "label"], rows: Array.from({ length: 12 }, (_, i) => [`行${i}`, "字段".repeat(60)]), count: 12 },
	}),
});
const cjkBudgetText = cjkBudgetSummary.content[0].text;
const cjkBudgetEnvelope = JSON.parse(cjkBudgetText);
assert.ok(cjkBudgetText.length <= 4_000, "check-token summaryBudget.cjk.length: CJK envelope must be measured with String.length");
assert.ok(Buffer.byteLength(cjkBudgetText, "utf8") > 4_000, "check-token summaryBudget.cjk.bytes: fixture must exceed byte budget so byteLength regressions are caught");
assert.equal(cjkBudgetEnvelope.summary.title, "中文预算页", "check-token summaryBudget.cjk.title: scalar identity must survive");
assert.equal(cjkBudgetEnvelope.summary.textPreview.length, 481, "check-token summaryBudget.cjk.preview: CJK preview must not be over-trimmed by byte accounting");
assert.equal(cjkBudgetEnvelope.summary.rows.rows.length, 12, "check-token summaryBudget.cjk.rows: CJK rows must survive under char budget");

const envelopeBudgetTmp = await mkdtemp(path.join(os.tmpdir(), "pi-browser-envelope-budget-"));
try {
	const noisyEntities = Array.from({ length: 40 }, (_, i) => ({
		ref: `pi-ref://entity/${i}`,
		kind: "control",
		role: "button",
		name: `Entity ${i} ${"x".repeat(160)}`,
		hints: { selector: `#entity-${i}`, text: "y".repeat(160), itemCount: i },
		structure: { label: "z".repeat(160), role: "button" },
	}));
	const savedFirst = await distilledJsonResult({ data: { blob: "r".repeat(20_000) } }, {
		toolName: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		maxChars: 4_000,
		ctx: { cwd: envelopeBudgetTmp },
		fallbackName: "saved-first-budget.json",
		artifactValue: { data: { blob: "r".repeat(20_000) } },
		distill: () => ({
			mode: "scan",
			sourceMode: "scan",
			summaryVersion: 2,
			browserSessionId: "default",
			tabId: 1,
			selectionVersionAtDispatch: 1,
			selectionVersionAtResolve: 1,
			abmlIntegrated: true,
			focus: {
				gist: { title: "Budget page", purpose: "budget regression" },
				primary_entities: noisyEntities,
			},
			snapshotProjection: { templates: noisyEntities.map((entity) => ({ entity, instances: noisyEntities })) },
		}),
	});
	const savedFirstText = savedFirst.content[0].text;
	const savedFirstEnvelope = JSON.parse(savedFirstText);
	assert.ok(savedFirstEnvelope.saved?.path, "check-token envelopeBudget.savedFirst: raw artifact must already be saved before envelope fitting");
	assert.ok(savedFirstText.length <= 4_000, `check-token envelopeBudget.savedFirst: envelope must fit maxChars even when saved already exists (${savedFirstText.length} > 4000)`);
	assert.equal(savedFirstEnvelope.summary.envelopeTruncatedToBudget, true, "check-token envelopeBudget.savedFirst: envelope-level truncation must be explicit");
	assert.ok(savedFirstEnvelope.diagnostics.warnings.some((item) => String(item).startsWith("envelope_omitted:")), "check-token envelopeBudget.savedFirst: diagnostics must identify omitted lifted fields");
} finally {
	await rm(envelopeBudgetTmp, { recursive: true, force: true });
}

const toolResultSource = read("src/utils/toolResult.ts");
assert.equal(toolResultSource.includes("result: value"), false, "toolResult must not add full result into details");
assert.ok(read("src/tools/resultMiddleware.ts").includes("fitSummaryBudget"), "result middleware must apply deterministic summary budget allocation");
assert.ok(read("src/tools/resultMiddleware.ts").includes("containsSensitiveEvidence") && read("src/tools/artifactReader.ts").includes("redactArtifactResult"), "artifact privacy governance must redact summaries and browser_artifact output by default");
assert.ok(read("src/tools/summaries/common.ts").includes("summaryTable"), "summary modules must support columns+rows compact tables");
assert.ok(read("skills/pi-browser-tools/SKILL.md").includes("detailLevel"), "pi-browser-tools skill must document detailLevel behavior");

console.log("token contract ok");
