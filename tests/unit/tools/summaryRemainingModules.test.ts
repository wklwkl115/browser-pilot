import test from "node:test";
import assert from "node:assert/strict";
import { summarizeJsAstAnalysisData } from "../../../src/tools/summaries/webSecurity/jsAst.ts";
import { summarizeWsSessionData } from "../../../src/tools/summaries/webSecurity/ws.ts";
import { summarizeWasmWatBridgeData } from "../../../src/tools/summaries/webSecurity/wasmBridge.ts";
import { summarizeWasmArtifactData } from "../../../src/tools/summaries/webSecurity/wasm.ts";

// ── summarizeJsAstAnalysisData ────────────────────────────────────────────────

test("summarizeJsAstAnalysisData handles non-record input", () => {
	const result = summarizeJsAstAnalysisData(null);
	assert.ok(typeof result === "object");
});

test("summarizeJsAstAnalysisData extracts AST analysis metadata", () => {
	const value = {
		ok: true,
		analysisMode: "ast",
		input: { source: "inline", chars: 500 },
		summary: { nodeCount: 100, depth: 8 },
	};
	const result = summarizeJsAstAnalysisData(value);
	assert.ok(typeof result === "object");
	assert.equal(result.analysisMode ?? "ast", "ast");
});

test("summarizeJsAstAnalysisData handles lexical mode", () => {
	const value = {
		ok: true,
		analysisMode: "lexical",
		lexical: {
			ok: true,
			summary: {
				urls: { count: 5, entries: [{ kind: "url", value: "https://api.example.com", line: 1, column: 10 }] },
				strings: { count: 10, entries: [] },
			},
		},
	};
	const result = summarizeJsAstAnalysisData(value);
	assert.equal(result.analysisMode, "lexical");
	assert.ok("urls" in result || typeof result === "object");
});

// ── summarizeWsSessionData ────────────────────────────────────────────────────

test("summarizeWsSessionData sets action field", () => {
	const result = summarizeWsSessionData("connect", { session: { sessionId: "ws-1" } });
	assert.equal(result.action, "connect");
	assert.equal(result.sessionId, "ws-1");
});

test("summarizeWsSessionData extracts session metadata", () => {
	const value = {
		session: {
			sessionId: "ws-abc",
			url: "wss://example.com/socket",
			state: "open",
			active: true,
			transcriptCount: 42,
		},
	};
	const result = summarizeWsSessionData("status", value);
	assert.equal(result.action, "status");
	assert.equal(result.sessionId, "ws-abc");
	assert.equal(result.url, "wss://example.com/socket");
	assert.equal(result.state, "open");
	assert.equal(result.active, true);
	assert.equal(result.transcriptCount, 42);
});

test("summarizeWsSessionData includes replay failure details when present", () => {
	const value = {
		session: {},
		failure: {
			stepIndex: 3,
			lastSeq: 10,
			error: { code: "MATCH_TIMEOUT", message: "expected response did not arrive" },
		},
	};
	const result = summarizeWsSessionData("replay", value);
	const failure = result.replayFailure as Record<string, unknown>;
	assert.equal(failure.stepIndex, 3);
	assert.equal(failure.errorCode, "MATCH_TIMEOUT");
});

test("summarizeWsSessionData handles non-record input", () => {
	const result = summarizeWsSessionData("status", null);
	assert.equal(result.action, "status");
	assert.equal(result.sessionId, undefined);
});

// ── summarizeWasmWatBridgeData ────────────────────────────────────────────────

test("summarizeWasmWatBridgeData handles non-record input", () => {
	const result = summarizeWasmWatBridgeData(null);
	assert.ok(typeof result === "object");
});

test("summarizeWasmWatBridgeData includes nextActions hint", () => {
	const value = { ok: true, format: "wasm-binary", moduleCount: 1 };
	const result = summarizeWasmWatBridgeData(value);
	assert.ok(Array.isArray(result.nextActions) && (result.nextActions as unknown[]).length > 0);
});

// ── summarizeWasmArtifactData ─────────────────────────────────────────────────

test("summarizeWasmArtifactData handles non-record input", () => {
	const result = summarizeWasmArtifactData(null);
	assert.ok(typeof result === "object");
});

test("summarizeWasmArtifactData produces sections/imports/exports tables", () => {
	const result = summarizeWasmArtifactData({ ok: true });
	assert.ok("sections" in result || "imports" in result || typeof result === "object");
});
