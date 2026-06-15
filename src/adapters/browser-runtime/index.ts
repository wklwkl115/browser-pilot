import type { BrowserRuntimeCommand, BrowserRuntimePort } from "../../ports/BrowserRuntimePort.js";

export type BrowserRuntimeSender = (command: BrowserRuntimeCommand, options?: { timeoutMs?: number; sessionId?: string }) => Promise<unknown>;

export function createBrowserRuntimeAdapter(send: BrowserRuntimeSender, status: () => Promise<unknown>): BrowserRuntimePort {
	return { send, status };
}
