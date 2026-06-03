import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureRefFromLifecycle, eventOrSignalEntitiesFromEvidenceBundle, inspectPayloadHandle, replayInputFromNetworkRef } from "../../../src/abml/verbs/streamRuntime.ts";
import { registerBrowserResultResource, clearResourceStore } from "../../../src/resources/resourceStore.ts";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("abml stream runtime expands payload handles through resource reader", async () => {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "abml-stream-inspect-"));
	try {
		const artifactPath = path.join(tmp, "payload.json");
		await writeFile(artifactPath, JSON.stringify({ body: { ok: true, detail: "payload" } }), "utf8");
		const uri = registerBrowserResultResource({ kind: "raw-result", artifactPath, name: "payload" });
		const inspected = await inspectPayloadHandle({ refId: "pi-ref://event/e1", kind: "event", locators: [], owner: {}, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false }, snapshot: { observationId: "obs-1", resourceUri: uri, immutable: true }, observationId: "obs-1", createdAt: Date.now(), ttlMs: 60_000 });
		assert.equal(inspected.ok, true);
		assert.match(inspected.content.text, /payload/);
	} finally {
		clearResourceStore();
		await rm(tmp, { recursive: true, force: true });
	}
});

test("abml stream runtime derives replay input from network-entry refs", async () => {
	const replay = replayInputFromNetworkRef({ refId: "pi-ref://network-entry/n1", kind: "network-entry", locators: [], owner: {}, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false }, snapshot: { observationId: "obs-1", resourceUri: "browser-result://request-1", immutable: true }, observationId: "obs-1", createdAt: Date.now(), ttlMs: 60_000 });
	assert.equal(replay.ok, true);
	assert.equal(replay.requestHandle, "browser-result://request-1");
});

test("abml stream runtime builds capture refs from lifecycle state", () => {
	const capture = createCaptureRefFromLifecycle({ refId: "pi-ref://signal/c1", state: "stopped", startedAt: 10, stoppedAt: 20, expiresAt: 100, lastSeq: 9, context: { observationId: "obs-1" } });
	assert.equal(capture.streamState.state, "stopped");
	assert.equal(capture.streamState.stoppedAt, 20);
	assert.equal(capture.streamState.lastSeq, 9);
});

test("abml stream runtime maps evidence bundles into event entities", () => {
	const entities = eventOrSignalEntitiesFromEvidenceBundle({
		sources: {
			hook_events: { ok: true, data: { events: [{ type: "console.log", message: "hello" }, { event: "dom.change", preview: "mutated" }] } },
		},
	}, { observationId: "obs-1", browserSessionId: "session-1", tabId: 7, url: "https://example.test/" });
	assert.equal(entities.length, 2);
	assert.equal(entities[0]?.entity.stream?.eventType, "console.log");
	assert.equal(entities[1]?.entity.stream?.phase, "hook_events");
});
