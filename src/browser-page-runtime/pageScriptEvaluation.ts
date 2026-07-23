import { BrowserBridgeError } from "../utils/errors.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";

function runtimeExceptionMessage(data: Record<string, unknown>): string | undefined {
	const exceptionDetails = data.exceptionDetails;
	if (!exceptionDetails || typeof exceptionDetails !== "object") return undefined;
	const details = exceptionDetails as Record<string, unknown>;
	const exception = details.exception && typeof details.exception === "object" ? details.exception as Record<string, unknown> : undefined;
	return typeof exception?.description === "string" ? exception.description : typeof details.text === "string" ? details.text : "Runtime.evaluate failed";
}

export async function evaluatePageScriptDirect(server: Pick<BrowserCommandRuntimePort, "sendCommand">, script: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number; name: string; signal?: AbortSignal }): Promise<BrowserBridgeExecutionResult> {
	const result = await server.sendCommand({
		cmd: "persistent_cdp",
		action: "send",
		cdpMethod: "Runtime.evaluate",
		name: "browser-pilot-script-eval",
		persistent: true,
		timeoutMs: options.timeoutMs,
		params: { expression: script, awaitPromise: true, returnByValue: true },
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, internal: true, signal: options.signal });
	const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
	const exceptionMessage = runtimeExceptionMessage(data);
	if (exceptionMessage) throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", exceptionMessage, { command: options.name, exceptionDetails: data.exceptionDetails });
	const resultEnvelope = data.result && typeof data.result === "object" ? data.result as Record<string, unknown> : undefined;
	const remote = resultEnvelope && "result" in resultEnvelope && typeof resultEnvelope.result === "object" && resultEnvelope.result !== null
		? resultEnvelope.result as Record<string, unknown>
		: resultEnvelope;
	if (!remote || !Object.prototype.hasOwnProperty.call(remote, "value")) {
		throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "Runtime.evaluate did not return a by-value result", { command: options.name, result: data.result });
	}
	return { ...result, data: remote.value };
}
