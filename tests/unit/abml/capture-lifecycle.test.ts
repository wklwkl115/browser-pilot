import test from "node:test";
import assert from "node:assert/strict";
import { createCaptureRefFromLifecycle } from "../../../src/abml/verbs/streamRuntime.ts";

test("capture lifecycle active/stopped/expired/lost states are preserved", () => {
	const active = createCaptureRefFromLifecycle({ refId: "pi-ref://signal/a", state: "active", startedAt: 1, expiresAt: 100, context: { observationId: "obs" } });
	const stopped = createCaptureRefFromLifecycle({ refId: "pi-ref://signal/b", state: "stopped", startedAt: 1, stoppedAt: 2, expiresAt: 100, context: { observationId: "obs" } });
	const expired = createCaptureRefFromLifecycle({ refId: "pi-ref://signal/c", state: undefined, startedAt: 1, expiresAt: 2, context: { observationId: "obs", capturedAt: 1 } });
	const lost = createCaptureRefFromLifecycle({ refId: "pi-ref://signal/d", state: "lost", startedAt: 1, expiresAt: 100, context: { observationId: "obs" } });
	assert.equal(active.streamState.state, "active");
	assert.equal(stopped.streamState.state, "stopped");
	assert.equal(stopped.streamState.stoppedAt, 2);
	assert.equal(expired.streamState.state, "expired");
	assert.equal(lost.streamState.state, "lost");
});
