import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";
import { validateMemoryRecord } from "../../../src/tools/memory/store.ts";
import { registerBrowserResultResource, clearResourceStore } from "../../../mcp/resourceStore.ts";
import { resolveBrowserResultEvidence } from "../../../mcp/memoryResourceStore.ts";
import type { MemoryEvidenceRef } from "../../../src/tools/memory/types.ts";

function freshCwd(): { cwd: string; artifactPath: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "memory-evidence-"));
	const artifactPath = path.join(cwd, ".pi", "browser-artifacts", "evidence.json");
	mkdirSync(path.dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, JSON.stringify({ ok: true }), "utf8");
	return { cwd, artifactPath };
}

function payload(evidenceRefs: Array<string | MemoryEvidenceRef>) {
	return { kind: "sop" as const, url: "https://www.site.com/x", title: "t", triggers: ["t1"], body: "1. step\n", evidenceRefs };
}

function codeOf(promise: Promise<unknown>): Promise<string | null> {
	return promise.then(() => null, (err: { code?: string }) => err?.code ?? "THROW");
}

// --- snapshot evidence against a real BrowserBridgeServer (no network start) ---

test("snapshot evidence resolves against a live registry's saved artifact", async () => {
	const { cwd, artifactPath } = freshCwd();
	const server = new BrowserBridgeServer();
	const snap = server.createObservationSnapshot({ sourceMode: "scan", capturedAt: Date.now(), url: "https://www.site.com/x", saved: { path: artifactPath } });
	const result = await validateMemoryRecord({ cwd, server, payload: payload([{ kind: "snapshot", snapshotId: snap.snapshotId }]) });
	const ref = result.entry.evidenceRefs.find((r) => r.kind === "snapshot");
	assert(ref, "resolved refs must include the snapshot ref");
	assert.equal(path.normalize(ref.path ?? ""), path.normalize(artifactPath), "snapshot evidence must resolve to its saved artifact path");
});

test("an expired snapshot is rejected as stale", async () => {
	const { cwd, artifactPath } = freshCwd();
	const server = new BrowserBridgeServer();
	const snap = server.createObservationSnapshot({ sourceMode: "scan", capturedAt: Date.now(), url: "https://www.site.com/x", saved: { path: artifactPath }, invalidatedReason: "ttl_expired" });
	assert.equal(await codeOf(validateMemoryRecord({ cwd, server, payload: payload([{ kind: "snapshot", snapshotId: snap.snapshotId }]) })), "MEMORY_EVIDENCE_STALE");
});

test("a snapshot without a saved artifact path is unreadable", async () => {
	const { cwd } = freshCwd();
	const server = new BrowserBridgeServer();
	const snap = server.createObservationSnapshot({ sourceMode: "scan", capturedAt: Date.now(), url: "https://www.site.com/x" });
	assert.equal(await codeOf(validateMemoryRecord({ cwd, server, payload: payload([{ kind: "snapshot", snapshotId: snap.snapshotId }]) })), "MEMORY_EVIDENCE_UNREADABLE");
});

test("a snapshot ref with no server is unresolvable", async () => {
	const { cwd } = freshCwd();
	assert.equal(await codeOf(validateMemoryRecord({ cwd, payload: payload([{ kind: "snapshot", snapshotId: "missing" }]) })), "MEMORY_EVIDENCE_UNRESOLVABLE");
});

// --- browser-result evidence against the real MCP resource store ---

test("browser-result evidence resolves through the real resource store", async () => {
	const { cwd, artifactPath } = freshCwd();
	const uri = registerBrowserResultResource({ kind: "raw-result", artifactPath, name: "evidence" });
	try {
		const result = await validateMemoryRecord({ cwd, resolver: resolveBrowserResultEvidence, payload: payload([uri]) });
		const ref = result.entry.evidenceRefs.find((r) => r.kind === "browser-result");
		assert(ref, "resolved refs must include the browser-result ref");
		assert.equal(path.normalize(ref.path ?? ""), path.normalize(artifactPath), "browser-result evidence must resolve to the server-side artifact path");
	} finally {
		clearResourceStore();
	}
});

test("a browser-result ref with no resolver injected is unresolvable", async () => {
	const { cwd } = freshCwd();
	assert.equal(await codeOf(validateMemoryRecord({ cwd, payload: payload(["browser-result://does-not-exist"]) })), "MEMORY_EVIDENCE_UNRESOLVABLE");
});

test("evidence is optional (GA-style): recording with no evidence succeeds", async () => {
	const { cwd } = freshCwd();
	const result = await validateMemoryRecord({ cwd, payload: payload([]) });
	assert.equal(result.entry.evidenceRefs.length, 0, "no evidence is allowed");
	assert.equal(result.scopeKey, "site.com");
});
