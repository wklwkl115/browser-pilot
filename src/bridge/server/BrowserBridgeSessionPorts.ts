import type { WebSocket } from "ws";
import type { BrowserAutomationSession } from "./types.js";

export type BrowserBridgeSessionRegistryPort = {
	defaultSession(): BrowserAutomationSession;
	require(sessionId?: string): BrowserAutomationSession;
	selectClient(session: BrowserAutomationSession, client: WebSocket | undefined): void;
	selectedOpenClient(session: BrowserAutomationSession): WebSocket | undefined;
	selectedInfo<TInfo>(session: BrowserAutomationSession, describe: (client: WebSocket) => TInfo | undefined): TInfo | undefined;
};
