import type { BrowserPilotBridgeWebSocketLike, JsonRecord } from "./types";

let getSocket: (() => BrowserPilotBridgeWebSocketLike | null) | undefined;

export function setBrowserPilotOperationEventSocketGetter(getter: () => BrowserPilotBridgeWebSocketLike | null): void {
	getSocket = getter;
}

export function emitBrowserPilotOperationEvent(operationId: string, event: JsonRecord): void {
	const socket = getSocket?.();
	if (!socket || socket.readyState !== 1) return;
	socket.send(JSON.stringify({ type: "operation_event", operationId, event }));
}
