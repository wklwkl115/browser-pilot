import test from "node:test";
import assert from "node:assert/strict";
import { summarizeFuzzPathsData } from "../../../src/tools/summaries/webSecurity/fuzz.ts";
import { summarizeSqliProbeData } from "../../../src/tools/summaries/webSecurity/sqli.ts";
import { summarizeWebReconProbeData as summarizeReconData } from "../../../src/tools/summaries/webSecurity/recon.ts";
import { summarizeCookieAnalyzeData } from "../../../src/tools/summaries/webSecurity/cookie.ts";

// ── summarizeFuzzPathsData ────────────────────────────────────────────────────

test("summarizeFuzzPathsData handles non-record input", () => {
	const result = summarizeFuzzPathsData(null);
	assert.equal(result.matchedCount, 0);
	assert.equal(result.failureCount, 0);
});

test("summarizeFuzzPathsData counts matched and failures", () => {
	const value = {
		ok: true,
		matched: [
			{ url: "https://example.com/admin", status: 200 },
			{ url: "https://example.com/backup", status: 200 },
		],
		failures: [{ url: "https://example.com/timeout", error: "timeout" }],
		results: [
			{ url: "https://example.com/admin", status: 200 },
			{ url: "https://example.com/backup", status: 200 },
			{ url: "https://example.com/404", status: 404 },
		],
	};
	const result = summarizeFuzzPathsData(value);
	assert.equal(result.matchedCount, 2);
	assert.equal(result.failureCount, 1);
	assert.equal(result.ok, true);
});

test("summarizeFuzzPathsData passes through metadata fields", () => {
	const value = {
		baseCount: 3,
		candidateCount: 500,
		requestCount: 450,
	};
	const result = summarizeFuzzPathsData(value);
	assert.equal(result.baseCount, 3);
	assert.equal(result.candidateCount, 500);
	assert.equal(result.requestCount, 450);
});

// ── summarizeSqliProbeData ────────────────────────────────────────────────────

test("summarizeSqliProbeData handles non-record input", () => {
	const result = summarizeSqliProbeData(null);
	assert.equal(result.matchedCount, 0);
	assert.equal(result.failureCount, 0);
});

test("summarizeSqliProbeData counts matched injections", () => {
	const value = {
		ok: true,
		matched: [
			{ type: "boolean-blind", location: "query", paramName: "id", payload: "1 OR 1=1", confidence: "high" },
		],
		results: [
			{ type: "boolean-blind", paramName: "id" },
			{ type: "time-based", paramName: "user" },
		],
		failures: [],
	};
	const result = summarizeSqliProbeData(value);
	assert.equal(result.matchedCount, 1);
	assert.equal(result.ok, true);
});

test("summarizeSqliProbeData computes typeCounts", () => {
	const value = {
		results: [
			{ type: "boolean-blind", paramName: "id" },
			{ type: "boolean-blind", paramName: "user" },
			{ type: "time-based", paramName: "id" },
		],
	};
	const result = summarizeSqliProbeData(value);
	const typeCounts = result.typeCounts as Array<{ key: string; count: number }>;
	const boolBlind = typeCounts.find((item) => item.key === "boolean-blind");
	assert.ok(boolBlind);
	assert.equal(boolBlind!.count, 2);
});

test("summarizeSqliProbeData passes through timeThresholdMs", () => {
	const result = summarizeSqliProbeData({ timeThresholdMs: 2000 });
	assert.equal(result.timeThresholdMs, 2000);
});

// ── summarizeReconData ────────────────────────────────────────────────────────

test("summarizeReconData handles non-record input", () => {
	const result = summarizeReconData(null);
	assert.ok(typeof result === "object");
});

test("summarizeReconData extracts ok and counts results", () => {
	const value = {
		ok: true,
		results: [
			{ ok: true, finalUrl: "https://example.com", status: 200 },
			{ ok: false, inputUrl: "https://bad.example.com" },
		],
	};
	const result = summarizeReconData(value);
	assert.equal(result.ok, true);
	assert.equal(result.count, 2);
	assert.equal(result.failed, 1);
});

// ── summarizeCookieAnalyzeData ────────────────────────────────────────────────

test("summarizeCookieAnalyzeData handles non-record input", () => {
	const result = summarizeCookieAnalyzeData(null);
	assert.ok(typeof result === "object");
});

test("summarizeCookieAnalyzeData extracts ok and cookie counts", () => {
	const value = {
		ok: true,
		cookieCount: 5,
		tokenCount: 2,
		verifiedCount: 1,
		url: "https://example.com",
	};
	const result = summarizeCookieAnalyzeData(value);
	assert.equal(result.ok, true);
	assert.equal(result.cookieCount, 5);
});
