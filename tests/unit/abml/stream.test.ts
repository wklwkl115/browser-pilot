import test from "node:test";
import assert from "node:assert/strict";
import { buildEventEntity, buildNetworkEntryEntity, createCaptureRef, mapCaptureState } from "../../../src/abml/stream.ts";

test("abml stream creates capture refs with lifecycle state", () => {
	const ref = createCaptureRef({
		refId: "pi-ref://signal/net-capture-1",
		state: "active",
		startedAt: 1710000000000,
		expiresAt: 1710003600000,
		lastSeq: 12,
		context: { browserSessionId: "session-1", tabId: 7, observationId: "obs-1", url: "https://example.test/" },
	});
	assert.equal(ref.kind, "signal");
	assert.equal(ref.streamState.state, "active");
	assert.equal(ref.streamState.lastSeq, 12);
	assert.equal(ref.owner.browserSessionId, "session-1");
});

test("abml stream maps recorder entries into network-entry entities", () => {
	const built = buildNetworkEntryEntity({
		requestId: "req-1",
		request: { url: "https://api.example.test/items", method: "POST" },
		response: { status: 201 },
		bodyRef: "browser-result://body-1",
		bodyAvailability: "captured",
		updatedAt: 1710000001000,
	}, { browserSessionId: "session-1", tabId: 7, observationId: "obs-1", capturedAt: 1710000000000, url: "https://example.test/" });
	assert.equal(built.entity.kind, "network-entry");
	assert.equal(built.entity.stream?.method, "POST");
	assert.equal(built.entity.stream?.status, 201);
	assert.equal(built.entity.stream?.payloadHandle, "browser-result://body-1");
	assert.equal(built.descriptor.snapshot?.resourceUri, "browser-result://body-1");
});

test("abml stream maps hook/evidence events into event entities", () => {
	const built = buildEventEntity({
		event: "console.error",
		phase: "collect",
		message: "boom",
		payloadHandle: "browser-result://evt-1",
		timestamp: 1710000002000,
	}, { browserSessionId: "session-1", tabId: 7, observationId: "obs-1", url: "https://example.test/" });
	assert.equal(built.entity.kind, "event");
	assert.equal(built.entity.name, "console.error");
	assert.equal(built.entity.stream?.phase, "collect");
	assert.equal(built.entity.stream?.payloadHandle, "browser-result://evt-1");
});

test("abml stream capture state helper expires by time", () => {
	assert.equal(mapCaptureState(undefined, 20, 10), "expired");
	assert.equal(mapCaptureState("lost", 0, 10), "lost");
});
