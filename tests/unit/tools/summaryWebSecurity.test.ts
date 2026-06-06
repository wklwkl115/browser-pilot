import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHttpReplayData } from "../../../src/tools/summaries/webSecurity/replay.ts";
import { summarizeBrowserCrawlData } from "../../../src/tools/summaries/webSecurity/crawl.ts";

// ── summarizeHttpReplayData ───────────────────────────────────────────────────

test("summarizeHttpReplayData handles non-record input", () => {
	const result = summarizeHttpReplayData(null);
	assert.equal(result.ok, undefined);
	assert.ok(Array.isArray(result.nextActions));
});

test("summarizeHttpReplayData extracts request and response metadata", () => {
	const value = {
		ok: true,
		mode: "single",
		stepCount: 1,
		failureCount: 0,
		request: {
			method: "POST",
			url: "https://api.example.com/login",
			headerNames: ["Content-Type", "Authorization"],
			bodyBytes: 256,
			cookiesBound: true,
		},
		response: {
			status: 200,
			statusText: "OK",
			headerNames: ["Content-Type"],
			body: { bytes: 512, sha256: "abc123", truncated: false },
			elapsedMs: 150,
		},
	};
	const result = summarizeHttpReplayData(value);
	assert.equal(result.ok, true);
	assert.equal(result.mode, "single");
	assert.equal(result.stepCount, 1);
	const req = result.request as Record<string, unknown>;
	assert.equal(req.method, "POST");
	assert.equal(req.headerCount, 2);
	assert.equal(req.bodyBytes, 256);
	assert.equal(req.cookiesBound, true);
	const resp = result.response as Record<string, unknown>;
	assert.equal(resp.status, 200);
	assert.equal(resp.bodyBytes, 512);
	assert.equal(resp.elapsedMs, 150);
});

test("summarizeHttpReplayData surfaces csrfReflected info", () => {
	const value = {
		ok: true,
		request: {
			csrfReflected: { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" },
		},
		response: { status: 200 },
	};
	const result = summarizeHttpReplayData(value);
	const req = result.request as Record<string, unknown>;
	const csrf = req.csrfReflected as Record<string, unknown>;
	assert.equal(csrf.cookie, "XSRF-TOKEN");
	assert.equal(csrf.header, "X-XSRF-TOKEN");
});

test("summarizeHttpReplayData computes steps table", () => {
	const value = {
		steps: [
			{ index: 0, source: "har", request: { method: "GET", url: "https://example.com/1" }, response: { status: 200, body: { bytes: 100 } } },
			{ index: 1, source: "inline", request: { method: "POST", url: "https://example.com/2" }, response: { status: 201, body: { bytes: 50 } } },
		],
	};
	const result = summarizeHttpReplayData(value);
	const steps = result.steps as { count: number };
	assert.equal(steps.count, 2);
});

test("summarizeHttpReplayData includes nextActions hints", () => {
	const result = summarizeHttpReplayData({});
	assert.ok(Array.isArray(result.nextActions));
	assert.ok((result.nextActions as string[]).length > 0);
});

// ── summarizeBrowserCrawlData ─────────────────────────────────────────────────

test("summarizeBrowserCrawlData handles non-record input", () => {
	const result = summarizeBrowserCrawlData(null);
	assert.equal(result.pageCount, 0);
	assert.equal(result.endpointCount, 0);
});

test("summarizeBrowserCrawlData counts pages, endpoints, failures", () => {
	const value = {
		ok: true,
		pages: [
			{ url: "https://example.com/", status: 200, title: "Home" },
			{ url: "https://example.com/about", status: 200, title: "About" },
		],
		endpoints: [
			{ url: "https://api.example.com/users", kind: "rest", method: "GET" },
		],
		failures: [
			{ url: "https://example.com/broken", error: "timeout" },
		],
	};
	const result = summarizeBrowserCrawlData(value);
	assert.equal(result.pageCount, 2);
	assert.equal(result.endpointCount, 1);
	assert.equal(result.failureCount, 1);
	assert.equal(result.ok, true);
});

test("summarizeBrowserCrawlData computes statusCounts", () => {
	const value = {
		pages: [
			{ url: "https://example.com/1", status: 200 },
			{ url: "https://example.com/2", status: 200 },
			{ url: "https://example.com/3", status: 404 },
		],
	};
	const result = summarizeBrowserCrawlData(value);
	const statusCounts = result.statusCounts as Array<{ key: string; count: number }>;
	const ok = statusCounts.find((item) => item.key === "200");
	assert.ok(ok);
	assert.equal(ok!.count, 2);
});

test("summarizeBrowserCrawlData includes nextActions hints", () => {
	const result = summarizeBrowserCrawlData({});
	assert.ok(Array.isArray(result.nextActions));
	assert.ok((result.nextActions as string[]).length > 0);
});
