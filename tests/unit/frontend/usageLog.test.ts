import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUsageLogOptions, buildUsageRecord, appendUsageRecord, createUsageLogHook } from "../../../src/frontend/usageLog.ts";
import type { MiddlewareContext } from "../../../src/frontend/middleware.ts";

const NOW = new Date("2026-06-02T12:34:56.789Z");

test("usageLog is disabled unless PI_BROWSER_USAGE_LOG is set", () => {
	assert.equal(resolveUsageLogOptions({}, "/cwd", NOW, 7).enabled, false);
	assert.equal(resolveUsageLogOptions({ PI_BROWSER_USAGE_LOG: "0" }, "/cwd", NOW, 7).enabled, false);
	assert.equal(resolveUsageLogOptions({ PI_BROWSER_USAGE_LOG: "false" }, "/cwd", NOW, 7).enabled, false);
});

test("usageLog resolves the default dated path for PI_BROWSER_USAGE_LOG=1", () => {
	const opts = resolveUsageLogOptions({ PI_BROWSER_USAGE_LOG: "1" }, path.resolve("/work"), NOW, 7);
	assert.equal(opts.enabled, true);
	assert.equal(opts.filePath, path.resolve("/work", ".pi", "usage", "usage-20260602.jsonl"));
	assert.equal(opts.raw, false);
	assert.match(opts.sessionId, /-7$/);
});

test("usageLog honors an explicit .jsonl path and the RAW flag", () => {
	const opts = resolveUsageLogOptions(
		{ PI_BROWSER_USAGE_LOG: "logs/run.jsonl", PI_BROWSER_USAGE_LOG_RAW: "1" },
		path.resolve("/work"),
		NOW,
		7,
	);
	assert.equal(opts.filePath, path.resolve("/work", "logs/run.jsonl"));
	assert.equal(opts.raw, true);
});

test("usageLog redacts secrets in args by default but keeps structural signal", () => {
	const opts = resolveUsageLogOptions({ PI_BROWSER_USAGE_LOG: "1" }, "/work", NOW, 7);
	const ctx: MiddlewareContext = {
		method: "tools/call",
		toolName: "browser_http_replay",
		startedAt: 0,
		cli: { command: "http-replay", routing: "standard" },
		args: { url: "https://target.test/api", password: "hunter2", mode: "GET" },
		resultBytes: 1234,
	};
	const record = buildUsageRecord(opts, ctx, 42, "ok", { code: "OK" }, NOW.toISOString());
	assert.equal(record.tool, "browser_http_replay");
	assert.equal(record.result, "ok");
	assert.equal(record.ms, 42);
	assert.equal(record.bytes, 1234);
	assert.deepEqual(record.cli, { command: "http-replay", routing: "standard" });
	const args = record.args as Record<string, unknown>;
	assert.equal(args.url, "https://target.test/api", "non-sensitive params are preserved");
	assert.equal(args.mode, "GET");
	assert.notEqual(args.password, "hunter2", "secrets must be redacted before disk");
});

test("usageLog records CLI routing metadata for natural-vs-legacy adoption", () => {
	const opts = resolveUsageLogOptions({ PI_BROWSER_USAGE_LOG: "1" }, "/work", NOW, 7);
	const record = buildUsageRecord(opts, {
		method: "invoke",
		toolName: "browser_wait",
		startedAt: 0,
		cli: {
			command: "wait",
			routing: "natural",
			naturalSubcommand: "selector",
			action: "selector",
		},
		args: { action: "selector", params: { selector: "#ready" } },
	}, 10, "ok", undefined, NOW.toISOString());
	assert.deepEqual(record.cli, {
		command: "wait",
		routing: "natural",
		naturalSubcommand: "selector",
		action: "selector",
	});
});

test("usageLog raw mode preserves args verbatim", () => {
	const opts = { enabled: true, filePath: "/x.jsonl", raw: true, sessionId: "s" };
	const ctx: MiddlewareContext = { method: "tools/call", toolName: "browser_observe", startedAt: 0, args: { token: "abc" } };
	const record = buildUsageRecord(opts, ctx, 1, "ok", undefined, NOW.toISOString());
	assert.deepEqual(record.args, { token: "abc" });
	assert.equal("details" in record, false, "empty details are omitted");
});

test("usageLog hook appends a parseable JSONL line", async () => {
	const file = path.join(os.tmpdir(), `pi-usage-test-${process.pid}.jsonl`);
	await rm(file, { force: true });
	try {
		const opts = { enabled: true, filePath: file, raw: false, sessionId: "sess-1" };
		await appendUsageRecord(file, buildUsageRecord(opts, { method: "tools/call", toolName: "browser_tabs", startedAt: 0, args: { action: "list" } }, 5, "ok", undefined, NOW.toISOString()));
		await appendUsageRecord(file, buildUsageRecord(opts, { method: "tools/call", toolName: "browser_sqli", startedAt: 0 }, 9, "error", { code: "INVALID_PARAMS" }, NOW.toISOString()));
		const lines = (await readFile(file, "utf8")).trim().split("\n");
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]);
		assert.equal(first.tool, "browser_tabs");
		assert.equal(first.session, "sess-1");
		assert.deepEqual(first.args, { action: "list" });
		const second = JSON.parse(lines[1]);
		assert.equal(second.result, "error");
		assert.equal((second.details as Record<string, unknown>).code, "INVALID_PARAMS");
		// hook variant must not throw on the hot path
		assert.doesNotThrow(() => createUsageLogHook(opts)({ method: "tools/call", toolName: "browser_wait", startedAt: 0 }, 1, "ok"));
	} finally {
		await rm(file, { force: true });
	}
});
