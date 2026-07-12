import type { BrowserPilotBridgeWebSocketLike, JsonRecord } from "./types";

let getSocket: (() => BrowserPilotBridgeWebSocketLike | null) | undefined;
const operationSockets = new Map<string, BrowserPilotBridgeWebSocketLike>();

export function setBrowserPilotOperationEventSocketGetter(getter: () => BrowserPilotBridgeWebSocketLike | null): void {
	getSocket = getter;
}

export function bindBrowserPilotOperationEventSocket(operationId: string, socket: BrowserPilotBridgeWebSocketLike): void {
	if (operationId) operationSockets.set(operationId, socket);
}

export function releaseBrowserPilotOperationEventSocket(operationId: string): void {
	operationSockets.delete(operationId);
}

export function emitBrowserPilotOperationEvent(operationId: string, event: JsonRecord): void {
	const bound = operationSockets.get(operationId);
	const socket = bound?.readyState === 1 ? bound : getSocket?.();
	if (!socket || socket.readyState !== 1) return;
	socket.send(JSON.stringify({ type: "operation_event", operationId, event }));
}
