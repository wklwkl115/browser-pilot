import assert from "node:assert/strict";
import test from "node:test";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static readonly instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.CONNECTING;
	closeCalls = 0;
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onclose?: () => void;
	onerror?: (event: { type: string }) => void;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(): void {}
	close(): void {
		this.closeCalls += 1;
		this.readyState = FakeWebSocket.CLOSED;
	}
}

test("offscreen transport closes a bridge socket when forwarding to the service worker fails", async () => {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const realFetch = globalThis.fetch;
	const realDebug = console.debug;
	const messages: Array<Record<string, unknown>> = [];
	Object.assign(globalThis, {
		setTimeout: () => 1,
		clearTimeout: () => undefined,
		fetch: async (input: string | URL | Request) => {
			if (String(input).endsWith(":18765")) return new Response("ok");
			throw new Error("closed");
		},
		WebSocket: FakeWebSocket,
		chrome: { runtime: {
			async sendMessage(message: Record<string, unknown>) {
				messages.push(message);
				if (message.type === "browser-pilot-offscreen-connected") throw new Error("service worker unavailable");
				return { ok: true };
			},
			onMessage: { addListener() {} },
		} },
	});
	console.debug = () => undefined;
	try {
		await import("../../src/bridge/extension/offscreen/transport.ts");
		for (let index = 0; index < 10 && !FakeWebSocket.instances.length; index += 1) await new Promise((resolve) => setImmediate(resolve));
		const socket = FakeWebSocket.instances[0];
		assert.ok(socket);
		socket.readyState = FakeWebSocket.OPEN;
		socket.onopen?.();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(socket.closeCalls, 1);
		assert.equal(messages.some((message) => message.type === "browser-pilot-offscreen-disconnected" && (message.data as Record<string, unknown>)?.reason === "service-worker-unreachable"), true);
	} finally {
		Object.assign(globalThis, { setTimeout: realSetTimeout, clearTimeout: realClearTimeout, fetch: realFetch });
		console.debug = realDebug;
	}
});
