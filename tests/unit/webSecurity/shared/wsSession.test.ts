import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { cleanupWsSessionsForTests, closeWsSession, collectWsSession, openWsSession, replayWsSequence, sendWsSession, waitWsSession } from "../../../../src/tools/webSecurity/shared/wsSession.ts";

const HOST = "127.0.0.1";

async function createFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = new WebSocketServer({ host: HOST, port: 0 });
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			const text = data.toString();
			if (text === "ping") socket.send(JSON.stringify({ ok: true, type: "pong" }));
			else socket.send(`echo:${text}`);
		});
	});
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	const address = server.address();
	assert(address && typeof address === "object");
	return {
		url: `ws://${HOST}:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}

test("wsSession supports explicit open/send/wait/collect/close transcript flow", async () => {
	const fixture = await createFixtureServer();
	try {
		const opened = await openWsSession({ sessionId: "unit", url: fixture.url, timeoutMs: 2_000, maxTranscript: 20 });
		assert.equal(opened.active, true);
		assert.equal(opened.state, "open");
		const sent = await sendWsSession({ sessionId: "unit", text: "ping" });
		assert.equal(sent.sent.preview, "ping");
		const matched = await waitWsSession({ sessionId: "unit", afterSeq: 0, contains: "pong", timeoutMs: 2_000 });
		assert.equal(matched.entry.event, "message");
		assert.equal(String(matched.entry.text).includes("pong"), true);
		const collected = collectWsSession({ sessionId: "unit", afterSeq: 0, limit: 10 });
		assert.equal(collected.count >= 3, true);
		assert.equal(collected.events.some((item) => item.event === "send"), true);
		assert.equal(collected.events.some((item) => item.event === "message"), true);
		const closed = await closeWsSession({ sessionId: "unit", timeoutMs: 2_000 });
		assert.equal(["closed", "error"].includes(String(closed.state)), true);
	} finally {
		await cleanupWsSessionsForTests();
		await fixture.close();
	}
});

test("wsSession replays explicit bounded message sequence", async () => {
	const fixture = await createFixtureServer();
	try {
		await openWsSession({ sessionId: "replay", url: fixture.url, timeoutMs: 2_000 });
		const replay = await replayWsSequence({ sessionId: "replay", steps: [
			{ text: "alpha", contains: "echo:alpha", timeoutMs: 2_000 },
			{ text: "beta", contains: "echo:beta", timeoutMs: 2_000 },
		] });
		assert.equal(replay.steps.length, 2);
		assert.equal(replay.steps[0].matched?.entry.text, "echo:alpha");
		assert.equal(replay.steps[1].matched?.entry.text, "echo:beta");
	} finally {
		await cleanupWsSessionsForTests();
		await fixture.close();
	}
});

test("wsSession reports replay failure with step index and partial transcript", async () => {
	const fixture = await createFixtureServer();
	try {
		await openWsSession({ sessionId: "replay-fail", url: fixture.url, timeoutMs: 2_000 });
		const replay = await replayWsSequence({ sessionId: "replay-fail", steps: [
			{ text: "alpha", contains: "echo:alpha", timeoutMs: 2_000 },
			{ text: "beta", contains: "never-match", timeoutMs: 50 },
		] });
		assert.equal(replay.failure?.stepIndex, 1);
		assert.equal(replay.failure?.lastSeq! >= 3, true);
		assert.equal(Array.isArray(replay.failure?.partialTranscript), true);
		assert.equal(replay.failure?.error.code, "WEBSOCKET_WAIT_TIMEOUT");
	} finally {
		await cleanupWsSessionsForTests();
		await fixture.close();
	}
});

test("wsSession rejects unsafe regex matcher", async () => {
	const fixture = await createFixtureServer();
	try {
		await openWsSession({ sessionId: "regex", url: fixture.url, timeoutMs: 2_000 });
		await assert.rejects(() => waitWsSession({ sessionId: "regex", regex: "(a+)+$", timeoutMs: 100 }), (error: Error & { code?: string }) => {
			assert.equal(error.code, "WEBSOCKET_INVALID_MATCHER");
			return true;
		});
	} finally {
		await cleanupWsSessionsForTests();
		await fixture.close();
	}
});
