import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BrowserBridgePendingRequests } from "../../../src/driver/BrowserBridgePendingRequests.ts";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";

function fakeSocket() {
	const sent: string[] = [];
	const socket = { send: (payload: string) => { sent.push(payload); } } as unknown as WebSocket;
	return { socket, sent };
}

const timeoutDiagnostics = () => ({});
const resolvedTarget = <T>(target: T) => target;

test("BrowserBridgePendingRequests rejects none-target pending requests when bridge stops", async () => {
	const pending = new BrowserBridgePendingRequests(timeoutDiagnostics, resolvedTarget);
	const { socket } = fakeSocket();
	const request = pending.send(socket, "1 + 1", { target: { source: "none", implicit: false, selectionVersionAtDispatch: 1 } });

	pending.rejectAllStopped();

	await assert.rejects(request, (error) => error instanceof BrowserBridgeError && error.code === "BRIDGE_STOPPED");
	assert.equal(pending.snapshot().length, 0);
});

test("BrowserBridgePendingRequests rejects all requests for a disconnected client", async () => {
	const pending = new BrowserBridgePendingRequests(timeoutDiagnostics, resolvedTarget);
	const { socket } = fakeSocket();
	const request = pending.send(socket, "1 + 1", { tabId: 3, target: { source: "explicit", tabId: 3, implicit: false, selectionVersionAtDispatch: 1 } });

	pending.rejectForClient(socket);

	await assert.rejects(request, (error) => error instanceof BrowserBridgeError && error.code === "BRIDGE_CLIENT_DISCONNECTED");
	assert.equal(pending.snapshot().length, 0);
});
