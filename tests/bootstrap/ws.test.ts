import assert from "node:assert/strict";
import test from "node:test";
import { validateBridgeCommand } from "../../src/types/nativeProtocol.ts";

type Listener = { callback: (event: Record<string, unknown>) => void; once: boolean };

class FakeWebSocket {
	static readonly instances: FakeWebSocket[] = [];
	readonly listeners = new Map<string, Listener[]>();
	readonly sent: string[] = [];
	closeCode?: number;
	closeReason?: string;

	constructor(readonly url: string, readonly protocols?: string[]) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, callback: (event: Record<string, unknown>) => void, options?: { once?: boolean }): void {
		this.listeners.set(type, [...(this.listeners.get(type) || []), { callback, once: options?.once === true }]);
	}

	removeEventListener(type: string, callback: (event: Record<string, unknown>) => void): void {
		this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.callback !== callback));
	}

	emit(type: string, event: Record<string, unknown> = {}): void {
		for (const listener of [...(this.listeners.get(type) || [])]) {
			listener.callback(event);
			if (listener.once) this.removeEventListener(type, listener.callback);
		}
	}

	send(text: string): void {
		this.sent.push(text);
	}

	close(code = 1000, reason = ""): void {
		this.closeCode = code;
		this.closeReason = reason;
		this.emit("close", { code, reason, wasClean: true });
	}
}

Object.assign(globalThis, {
	chrome: {
		runtime: { id: "ws-test" },
		storage: { session: { get: async () => ({}), set: async () => undefined } },
		tabs: { get: async (id: number) => ({ id }) },
	},
	WebSocket: FakeWebSocket,
});

const model = await import("../../src/bridge/extension/service_worker/ws_model.ts");
const wsRuntime = await import("../../src/bridge/extension/service_worker/ws.ts");

test("ws.open rejects unused headers and oversized inbound frames fail closed without parsing or storage", async () => {
	const rejected = validateBridgeCommand({ cmd: "ws.open", tabId: 7, url: "wss://example.test/socket", headers: { authorization: "secret" } });
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.match(rejected.error, /headers/);
	assert.equal("headers" in model.normalizeWsOpenConfig({ url: "wss://example.test/socket", headers: { authorization: "secret" } }), false);

	const opening = wsRuntime.handleBrowserPilotWsCommand("ws.open", 7, { cmd: "ws.open", url: "wss://example.test/socket" });
	const socket = FakeWebSocket.instances.at(-1);
	assert.ok(socket);
	socket.emit("open");
	assert.equal((await opening).ok, true);

	const marker = "oversized-frame-must-not-be-stored";
	const frame = JSON.stringify({ marker, padding: "x".repeat(wsRuntime.BROWSER_PILOT_WS_MAX_INBOUND_FRAME_BYTES) });
	const originalParse = JSON.parse;
	let parseCalls = 0;
	JSON.parse = ((text: string) => {
		parseCalls += 1;
		return originalParse(text);
	}) as typeof JSON.parse;
	try {
		socket.emit("message", { data: frame });
	} finally {
		JSON.parse = originalParse;
	}

	const status = await wsRuntime.handleBrowserPilotWsCommand("ws.status", 7, { cmd: "ws.status" });
	const session = (status.data as { session: Record<string, unknown> }).session;
	const transcript = model.browserPilotWsSessions.get("7:default")?.transcript || [];
	assert.equal(parseCalls, 0);
	assert.equal(session.state, "error");
	assert.match(String(session.lastError), /exceeds 65536-byte limit/);
	assert.equal(socket.closeCode, 1009);
	assert.equal(transcript.some((entry) => entry.event === "message"), false);
	assert.equal(transcript.at(-1)?.event, "error");
	assert.equal(JSON.stringify(transcript).includes(marker), false);
	assert.equal("headers" in session, false);
	model.browserPilotWsSessions.clear();
});

test("ws session supports send, wait, replay, collect, and explicit close", async () => {
	const opening = wsRuntime.handleBrowserPilotWsCommand("ws.open", 7, { cmd: "ws.open", sessionId: "flow", url: "wss://example.test/flow", protocols: ["json"] });
	const socket = FakeWebSocket.instances.at(-1)!;
	socket.emit("open");
	assert.equal((await opening).ok, true);

	const sent = await wsRuntime.handleBrowserPilotWsCommand("ws.send", 7, { cmd: "ws.send", sessionId: "flow", text: "hello" });
	assert.equal(sent.ok, true);
	assert.deepEqual(socket.sent, ["hello"]);
	socket.emit("message", { data: JSON.stringify({ event: "ready" }) });
	const immediate = await wsRuntime.handleBrowserPilotWsCommand("ws.wait", 7, { cmd: "ws.wait", sessionId: "flow", contains: "ready" });
	assert.equal((immediate.data as Record<string, unknown>).matchedImmediately, true);

	const replay = wsRuntime.handleBrowserPilotWsCommand("ws.replay", 7, { cmd: "ws.replay", sessionId: "flow", steps: [{ text: "ping", contains: "pong", timeoutMs: 500 }] });
	await new Promise((resolve) => setImmediate(resolve));
	socket.emit("message", { data: "pong" });
	assert.equal((await replay).ok, true);
	assert.deepEqual(socket.sent, ["hello", "ping"]);

	const collected = await wsRuntime.handleBrowserPilotWsCommand("ws.collect", 7, { cmd: "ws.collect", sessionId: "flow", limit: 20 });
	assert.ok(Number((collected.data as Record<string, unknown>).count) >= 5);
	const closed = await wsRuntime.handleBrowserPilotWsCommand("ws.close", 7, { cmd: "ws.close", sessionId: "flow", code: 1000, reason: "done" });
	assert.equal(((closed.data as { session: Record<string, unknown> }).session).state, "closed");
	assert.equal(socket.closeReason, "done");
	assert.equal(wsRuntime.cleanupWsSessionsForTab(7).removed, 1);
	assert.equal(model.browserPilotWsSessions.size, 0);
});
