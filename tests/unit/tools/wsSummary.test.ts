import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWsSessionData } from "../../../src/tools/summaries/webSecurity/ws.ts";

test("ws summary adapter emits compact session and transcript facts", () => {
	const summary = summarizeWsSessionData("ws.collect", {
		session: { sessionId: "s1", url: "ws://127.0.0.1:9999", state: "open", active: true, transcriptCount: 4, maxTranscript: 20 },
		failure: { stepIndex: 1, lastSeq: 4, error: { code: "WEBSOCKET_WAIT_TIMEOUT", message: "timeout" } },
		steps: [{ index: 0, sent: { seq: 2, preview: "ping" }, matched: { entry: { seq: 3, preview: '{"ok":true,"type":"pong"}' } } }],
		events: [
			{ seq: 1, event: "open" },
			{ seq: 2, event: "send", direction: "outbound", bytes: 4, preview: "ping" },
			{ seq: 3, event: "message", direction: "inbound", bytes: 24, preview: '{"ok":true,"type":"pong"}' },
		],
	});
	assert.equal(summary.sessionId, "s1");
	assert.equal(summary.state, "open");
	assert.equal(summary.transcriptCount, 4);
	assert.equal(typeof summary.events, "object");
	assert.equal(typeof summary.replaySteps, "object");
	assert.equal(typeof summary.replayFailure, "object");
	assert.equal(Array.isArray(summary.nextActions), true);
});
