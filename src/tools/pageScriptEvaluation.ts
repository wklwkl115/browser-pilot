import { BrowserBridgeError } from "../driver/errors";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer";
import type { BrowserBridgeExecutionResult } from "../driver/types";

function runtimeExceptionMessage(data: Record<string, unknown>): string | undefined {
	const exceptionDetails = data.exceptionDetails;
	if (!exceptionDetails || typeof exceptionDetails !== "object") return undefined;
	const details = exceptionDetails as Record<string, unknown>;
	const exception = details.exception && typeof details.exception === "object" ? details.exception as Record<string, unknown> : undefined;
	return typeof exception?.description === "string" ? exception.description : typeof details.text === "string" ? details.text : "Runtime.evaluate failed";
}

export async function evaluatePageScriptDirect(server: BrowserBridgeServer, script: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number; name: string }): Promise<BrowserBridgeExecutionResult> {
	const result = await server.sendCommand({
		cmd: "cdp",
		method: "Runtime.evaluate",
		name: options.name,
		persistent: false,
		timeoutMs: options.timeoutMs,
		params: { expression: script, awaitPromise: true, returnByValue: true },
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
	const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
	const exceptionMessage = runtimeExceptionMessage(data);
	if (exceptionMessage) throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", exceptionMessage, { command: options.name, exceptionDetails: data.exceptionDetails });
	const remote = data.result && typeof data.result === "object" ? data.result as Record<string, unknown> : undefined;
	if (!remote || !Object.prototype.hasOwnProperty.call(remote, "value")) {
		throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "Runtime.evaluate did not return a by-value result", { command: options.name, result: data.result });
	}
	return { ...result, data: remote.value };
}
