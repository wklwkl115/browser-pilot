/**
 * Token-economy baseline contract (Residual F / §6 metric #3, Phase 10C).
 *
 * Measures Layer-0 (distilled summary) size vs raw result size across a broader
 * deterministic fixture set. Chars via stableJson().length are the project-wide
 * token proxy because result budgets are char-based.
 *
 * Hard gate: every fixture must have layer0 < raw.
 * Soft guardrail: fixture raw sizes are locked and layer0 may grow only within
 * TOLERANCE versus the committed baseline.
 *
 * Regenerate deliberately with: npm run check:token-economy -- --update
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { stableJson } from "../../../src/utils/json.ts";
import { distilledJsonResult } from "../../../src/tools/resultMiddleware.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, "fixtures", "token-economy-baseline.json");
const summaryPath = path.join(root, ".pi", "browser-artifacts", "token-economy-summary.json");
const UPDATE = process.argv.includes("--update");
const TOLERANCE = 0.1;

function evidenceFixture() {
	const sources = {};
	for (let i = 0; i < 8; i += 1) {
		sources[`source_${i}`] = { ok: true, data: { events: Array.from({ length: 5 }, (_, j) => ({ type: `evt_${i % 3}`, seq: j, message: `fixture event ${i}-${j}` })), items: [{ tag: "DIV", idx: i }] } };
	}
	return { tabId: 1, collected_at: "2026-06-01T00:00:00Z", event_types: ["console", "network", "storage"], sources };
}

function networkFixture() {
	const entries = Array.from({ length: 90 }, (_, i) => ({
		requestId: String(i),
		url: `https://host${i % 3}.example.test/api/resource/${i}?query=fixture-${i}&page=${i % 9}`,
		method: i % 4 === 0 ? "POST" : "GET",
		status: i % 9 === 0 ? 500 : i % 5 === 0 ? 404 : 200,
		type: "Fetch",
		request: { url: `https://host${i % 3}.example.test/api/resource/${i}?query=fixture-${i}&page=${i % 9}`, method: i % 4 === 0 ? "POST" : "GET", headers: { accept: "application/json", "x-fixture": `network-${i}` } },
		response: { status: i % 9 === 0 ? 500 : i % 5 === 0 ? 404 : 200, mimeType: "application/json", bodyPreview: `fixture response body ${i} `.repeat(4) },
	}));
	return { tabId: 7, sessionId: "tok-econ", total: entries.length, entries };
}

function hookFixture() {
	const listeners = Array.from({ length: 20 }, (_, i) => ({
		type: ["click", "submit", "input", "change"][i % 4],
		useCapture: i % 2 === 0,
		passive: false,
		once: false,
		handler: { url: `https://h${i % 3}.test/a.js`, line: 100 + i, column: i % 40, functionName: `fn_${i % 5}` },
	}));
	return { selector: "#root", node: { tagName: "DIV", id: "root" }, count: listeners.length, listeners };
}

function scanFixture() {
	return {
		url: "https://app.example.test/dashboard",
		actionables: Array.from({ length: 35 }, (_, i) => ({ selector: `#action-${i}`, text: `Action ${i}`, role: i % 2 ? "button" : "link", visible: true })),
		forms: Array.from({ length: 8 }, (_, i) => ({ selector: `form:nth-of-type(${i + 1})`, fields: ["name", "email", "csrf", `custom_${i}`], submitText: "Save" })),
		text: "Dashboard fixture ".repeat(120),
	};
}

function crawlFixture() {
	return {
		ok: true,
		maxDepth: 2,
		pages: Array.from({ length: 18 }, (_, i) => ({ url: `https://crawl.example.test/page/${i}`, status: i % 7 === 0 ? 404 : 200, title: `Page ${i}`, depth: i % 3, links: ["/a", "/b", "/c"], forms: i % 4 === 0 ? [{ action: "/submit", method: "POST" }] : [], endpoints: [{ url: `/api/${i}`, method: "GET" }] })),
		endpoints: Array.from({ length: 22 }, (_, i) => ({ url: `https://crawl.example.test/api/${i}`, kind: "fetch", method: i % 3 === 0 ? "POST" : "GET", source: "script", parameterCount: i % 5 })),
		failures: [{ url: "https://crawl.example.test/missing", error: "404" }],
	};
}

function fuzzFixture() {
	return {
		ok: true,
		baseCount: 2,
		candidateCount: 80,
		requestCount: 80,
		filterBaseline: true,
		baselineStrategy: "cluster",
		matched: Array.from({ length: 15 }, (_, i) => ({ url: `https://fuzz.example.test/admin/${i}`, depth: i % 2, status: i % 3 === 0 ? 403 : 200, title: `Matched ${i}`, bodyBytes: 1200 + i, bodySha256: `sha-${i}`, differentFromBaseline: true })),
		results: Array.from({ length: 50 }, (_, i) => ({ url: `https://fuzz.example.test/path/${i}`, status: i % 6 === 0 ? 404 : 200, bodyBytes: 900 + i })),
	};
}

function sqliFixture() {
	return {
		ok: true,
		requestCount: 24,
		matched: Array.from({ length: 6 }, (_, i) => ({ parameter: `id${i}`, payload: "'", evidence: "SQL syntax fixture", statusDelta: i % 2, bodyDelta: 120 + i })),
		cases: Array.from({ length: 30 }, (_, i) => ({ location: "query", name: `id${i % 5}`, payloadType: ["boolean", "error", "time"][i % 3], status: i % 4 === 0 ? 500 : 200, bodyBytes: 1000 + i })),
	};
}

function replayFixture() {
	return {
		ok: true,
		requestCount: 18,
		baseline: { status: 200, bodyBytes: 1200, bodySha256: "base" },
		results: Array.from({ length: 18 }, (_, i) => ({ label: `variant-${i}`, status: i % 5 === 0 ? 403 : 200, bodyBytes: 1200 + i * 3, bodySha256: `body-${i}`, delta: i % 5 === 0 ? "authz" : "none" })),
	};
}

function sensitiveArtifactFixture() {
	return {
		ok: true,
		cookies: Array.from({ length: 10 }, (_, i) => ({ name: `session_${i}`, value: `fixture-secret-${i}-abcdef`, httpOnly: true, secure: true })),
		headers: { authorization: "Bearer fixture-token-redacted", cookie: "session_fixture=fixture-secret" },
		findings: Array.from({ length: 12 }, (_, i) => ({ type: "secret-like", redacted: true, path: `headers.${i}` })),
	};
}

const FIXTURES = [
	{ id: "evidence-bundle", name: "browser_evidence", command: "evidence.collect", value: evidenceFixture() },
	{ id: "network-list", name: "browser_network", command: "network.list", value: networkFixture() },
	{ id: "hook-listeners", name: "browser_hook", command: "hook.getNodeListeners", value: hookFixture() },
	{ id: "scan-summary", name: "browser_observe", command: "scan_extract", value: scanFixture() },
	{ id: "web-crawl", name: "browser_crawl", command: "crawl", value: crawlFixture() },
	{ id: "web-fuzz", name: "browser_fuzz", command: "fuzz.path", value: fuzzFixture() },
	{ id: "web-sqli", name: "browser_sqli", command: "sqli.builtin", value: sqliFixture() },
	{ id: "http-replay", name: "browser_http_replay", command: "http.replay", value: replayFixture() },
	{ id: "large-sensitive-artifact", name: "browser_cookie_analyze", command: "cookie.analyze", value: sensitiveArtifactFixture() },
];

const ctxDir = mkdtempSync(path.join(tmpdir(), "tok-econ-"));

async function measure(fx) {
	const rawChars = stableJson(fx.value).length;
	const r = await distilledJsonResult(fx.value, {
		toolName: fx.name,
		command: fx.command,
		maxChars: 12000,
		fallbackName: `${fx.id}.json`,
		detailLevel: "summary",
		ctx: { cwd: ctxDir },
	});
	const envelope = JSON.parse(r.content[0].text);
	const layer0Chars = stableJson(envelope.summary).length;
	return { id: fx.id, name: fx.name, command: fx.command, rawChars, layer0Chars, ratio: Number((layer0Chars / rawChars).toFixed(4)), saved: envelope.saved != null };
}

const results = [];
for (const fx of FIXTURES) results.push(await measure(fx));

const ratios = results.map((r) => r.ratio).sort((a, b) => a - b);
const medianRatio = ratios[Math.floor(ratios.length / 2)];
const p90Ratio = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.9))];
const maxRatio = ratios[ratios.length - 1];

for (const r of results) assert(r.layer0Chars < r.rawChars, `${r.id}: Layer-0 (${r.layer0Chars}) must be smaller than raw (${r.rawChars})`);

const current = { proxy: "chars/stableJson", note: "n=9 deterministic guardrail; layer0 = stableJson(envelope.summary)", fixtures: results, medianRatio, p90Ratio, maxRatio };
mkdirSync(path.dirname(summaryPath), { recursive: true });
writeFileSync(summaryPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

if (UPDATE) {
	writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
	console.log("token economy baseline UPDATED:", JSON.stringify({ fixtures: results.length, medianRatio, p90Ratio, maxRatio, summaryPath }));
} else {
	let baseline;
	try {
		baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	} catch {
		assert.fail("token-economy-baseline.json missing — run: npm run check:token-economy -- --update");
	}
	for (const r of results) {
		const b = baseline.fixtures.find((x) => x.id === r.id);
		assert(b, `baseline missing fixture ${r.id} — regenerate with --update`);
		assert.equal(r.rawChars, b.rawChars, `${r.id}: rawChars drifted (${r.rawChars} vs baseline ${b.rawChars}) — fixtures changed; regenerate with --update`);
		assert(r.layer0Chars <= Math.ceil(b.layer0Chars * (1 + TOLERANCE)), `${r.id}: Layer-0 grew beyond +${TOLERANCE * 100}% (${r.layer0Chars} vs baseline ${b.layer0Chars}) — investigate or regenerate with --update`);
	}
	assert(results.length >= 8, "token economy must cover at least 8 deterministic fixtures");
	console.log(`token economy ok (fixtures=${results.length}, medianRatio=${medianRatio}, p90Ratio=${p90Ratio}, maxRatio=${maxRatio}, summary=${summaryPath})`);
}
