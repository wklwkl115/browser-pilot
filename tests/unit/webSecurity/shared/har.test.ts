import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harHeaderValues, harDependencyRequestInfo, harDependencyResponseInfo, buildHarDependencyGraph, harEntriesFromOptions } from "../../../../src/tools/webSecurity/shared/har.ts";

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "har-test-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = fn(dir);
		if (result && typeof (result as Promise<void>).then === "function") {
			return (result as Promise<void>).finally(cleanup);
		}
		cleanup();
		return Promise.resolve();
	} catch (e) {
		cleanup();
		return Promise.reject(e);
	}
}

// ── harHeaderValues ───────────────────────────────────────────────────────────

test("harHeaderValues extracts header from array format", () => {
	const headers = [
		{ name: "Content-Type", value: "application/json" },
		{ name: "X-Auth-Token", value: "secret" },
		{ name: "content-type", value: "text/html" },
	];
	const result = harHeaderValues(headers, "content-type");
	assert.deepEqual(result, ["application/json", "text/html"]);
});

test("harHeaderValues extracts header from object format", () => {
	const headers = { "Content-Type": "application/json", "X-Custom": "value" };
	const result = harHeaderValues(headers, "content-type");
	assert.deepEqual(result, ["application/json"]);
});

test("harHeaderValues returns empty array when header not found", () => {
	const result = harHeaderValues([{ name: "Accept", value: "text/html" }], "Authorization");
	assert.deepEqual(result, []);
});

test("harHeaderValues handles non-array/non-object input", () => {
	assert.deepEqual(harHeaderValues(null, "content-type"), []);
	assert.deepEqual(harHeaderValues("raw-string", "content-type"), []);
});

// ── harDependencyRequestInfo ──────────────────────────────────────────────────

test("harDependencyRequestInfo extracts url, method, headers from HAR entry", () => {
	const entry = {
		request: {
			url: "https://api.example.com/data",
			method: "POST",
			headers: [
				{ name: "Content-Type", value: "application/json" },
				{ name: "Cookie", value: "session=abc123" },
			],
		},
	};
	const result = harDependencyRequestInfo(entry);
	assert.equal(result.url, "https://api.example.com/data");
	assert.equal(result.method, "POST");
	assert.equal(result.cookieHeader, "session=abc123");
});

test("harDependencyRequestInfo returns empty values for non-record entry", () => {
	const result = harDependencyRequestInfo(null);
	assert.equal(result.url, undefined);
	assert.equal(result.method, undefined);
});

// ── harDependencyResponseInfo ─────────────────────────────────────────────────

test("harDependencyResponseInfo extracts status and location from redirect response", () => {
	const entry = {
		request: { url: "https://old.example.com" },
		response: {
			status: 302,
			redirectURL: "https://new.example.com",
			headers: [],
		},
	};
	const result = harDependencyResponseInfo(entry, "https://old.example.com");
	assert.equal(result.status, 302);
	assert.ok(result.location !== undefined);
});

test("harDependencyResponseInfo parses set-cookie headers", () => {
	const entry = {
		request: { url: "https://example.com" },
		response: {
			status: 200,
			headers: [{ name: "Set-Cookie", value: "session=abc; Path=/; HttpOnly" }],
		},
	};
	const result = harDependencyResponseInfo(entry);
	assert.ok(result.cookies.length >= 1);
	assert.ok(result.cookies.some((c) => c?.name === "session"));
});

// ── buildHarDependencyGraph ───────────────────────────────────────────────────

test("buildHarDependencyGraph returns undefined when no har sources", () => {
	const result = buildHarDependencyGraph([{ input: {}, source: "inline" }]);
	assert.equal(result, undefined);
});

test("buildHarDependencyGraph builds nodes for HAR entries", () => {
	const sequence = [
		{
			source: "har",
			input: {
				request: { url: "https://example.com/login", method: "GET", headers: [] },
				response: { status: 200, headers: [] },
			},
		},
		{
			source: "har",
			input: {
				request: { url: "https://example.com/api/data", method: "POST", headers: [] },
				response: { status: 200, headers: [] },
			},
		},
	];
	const result = buildHarDependencyGraph(sequence);
	assert.ok(result !== undefined);
	assert.equal(result!.nodeCount, 2);
	assert.ok(Array.isArray(result!.nodes));
});

test("buildHarDependencyGraph detects cookie dependency edge", () => {
	const sequence = [
		{
			source: "har",
			input: {
				request: { url: "https://example.com/login", method: "POST", headers: [] },
				response: {
					status: 200,
					headers: [{ name: "Set-Cookie", value: "session=xyz; Path=/" }],
				},
			},
		},
		{
			source: "har",
			input: {
				request: {
					url: "https://example.com/profile",
					method: "GET",
					headers: [{ name: "Cookie", value: "session=xyz" }],
				},
				response: { status: 200, headers: [] },
			},
		},
	];
	const result = buildHarDependencyGraph(sequence);
	assert.ok(result !== undefined);
	assert.ok(result!.edgeCount >= 1);
	const cookieEdge = (result!.edges as Array<{ type: string }>).find((e) => e.type === "cookie");
	assert.ok(cookieEdge !== undefined);
});

// ── harEntriesFromOptions (with filesystem) ───────────────────────────────────

test("harEntriesFromOptions returns empty array when no har or harPath", async () => {
	const result = await harEntriesFromOptions({} as Parameters<typeof harEntriesFromOptions>[0]);
	assert.deepEqual(result, []);
});

test("harEntriesFromOptions reads entries from harPath JSON file", async () => {
	await withTempDir(async (dir) => {
		const harFile = path.join(dir, "test.har");
		const har = {
			log: {
				entries: [
					{ request: { url: "https://example.com/1", method: "GET", headers: [] }, response: { status: 200, headers: [] } },
					{ request: { url: "https://example.com/2", method: "POST", headers: [] }, response: { status: 201, headers: [] } },
				],
			},
		};
		writeFileSync(harFile, JSON.stringify(har));
		const result = await harEntriesFromOptions({ harPath: harFile } as Parameters<typeof harEntriesFromOptions>[0]);
		assert.equal(result.length, 2);
	});
});

test("harEntriesFromOptions filters entries by harUrlPattern", async () => {
	await withTempDir(async (dir) => {
		const harFile = path.join(dir, "test.har");
		const har = {
			log: {
				entries: [
					{ request: { url: "https://api.example.com/users", method: "GET", headers: [] }, response: { status: 200, headers: [] } },
					{ request: { url: "https://api.example.com/products", method: "GET", headers: [] }, response: { status: 200, headers: [] } },
					{ request: { url: "https://static.example.com/app.js", method: "GET", headers: [] }, response: { status: 200, headers: [] } },
				],
			},
		};
		writeFileSync(harFile, JSON.stringify(har));
		const result = await harEntriesFromOptions({ harPath: harFile, harUrlPattern: "api\\.example\\.com" } as Parameters<typeof harEntriesFromOptions>[0]);
		assert.equal(result.length, 2);
	});
});
