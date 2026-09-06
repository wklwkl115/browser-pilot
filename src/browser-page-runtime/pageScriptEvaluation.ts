import { BrowserBridgeError } from "../utils/errors.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";

function runtimeExceptionMessage(data: Record<string, unknown>): string | undefined {
	const exceptionDetails = data.exceptionDetails;
	if (!exceptionDetails || typeof exceptionDetails !== "object") return undefined;
	const details = exceptionDetails as Record<string, unknown>;
	const exception =
		details.exception && typeof details.exception === "object"
			? (details.exception as Record<string, unknown>)
			: undefined;
	return typeof exception?.description === "string"
		? exception.description
		: typeof details.text === "string"
			? details.text
			: "Runtime.evaluate failed";
}

const scriptHashByText = new Map<string, string>();
const MAX_HASHED_SCRIPTS = 32;

/**
 * Stable per-script hash so the extension can cache the compiled script (Runtime.compileScript)
 * after it has seen the same source twice. The 47KB page scan runs on every observe; without this
 * the browser re-parses it each time.
 */
function scriptHash(script: string): string {
	const cached = scriptHashByText.get(script);
	if (cached) return cached;
	let hash = 2166136261;
	for (let index = 0; index < script.length; index += 1) {
		hash ^= script.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	const value = `${(hash >>> 0).toString(36)}:${script.length}`;
	if (scriptHashByText.size >= MAX_HASHED_SCRIPTS) scriptHashByText.delete(scriptHashByText.keys().next().value!);
	scriptHashByText.set(script, value);
	return value;
}

export async function evaluatePageScriptDirect(
	server: Pick<BrowserCommandRuntimePort, "sendCommand">,
	script: string,
	options: {
		browserSessionId?: string;
		tabId?: unknown;
		timeoutMs: number;
		name: string;
		signal?: AbortSignal;
		/** Opt into compiled-script reuse for scripts that are re-run verbatim (page scans). */
		reusable?: boolean;
	},
): Promise<BrowserBridgeExecutionResult> {
	const result = await server.sendCommand(
		{
			cmd: "persistent_cdp",
			action: "send",
			cdpMethod: "Runtime.evaluate",
			name: "browser-pilot-script-eval",
			persistent: true,
			timeoutMs: options.timeoutMs,
			...(options.reusable ? { precompile: true, scriptHash: scriptHash(script) } : {}),
			params: { expression: script, awaitPromise: true, returnByValue: true },
		},
		{
			browserSessionId: options.browserSessionId,
			tabId: options.tabId as number | string | undefined,
			timeoutMs: options.timeoutMs,
			internal: true,
			signal: options.signal,
		},
	);
	const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
	const exceptionMessage = runtimeExceptionMessage(data);
	if (exceptionMessage)
		throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", exceptionMessage, {
			command: options.name,
			exceptionDetails: data.exceptionDetails,
		});
	const resultEnvelope =
		data.result && typeof data.result === "object" ? (data.result as Record<string, unknown>) : undefined;
	const remote =
		resultEnvelope &&
		"result" in resultEnvelope &&
		typeof resultEnvelope.result === "object" &&
		resultEnvelope.result !== null
			? (resultEnvelope.result as Record<string, unknown>)
			: resultEnvelope;
	if (!remote || !Object.prototype.hasOwnProperty.call(remote, "value")) {
		throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", "Runtime.evaluate did not return a by-value result", {
			command: options.name,
			result: data.result,
		});
	}
	return { ...result, data: remote.value };
}
