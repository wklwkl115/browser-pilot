import { BrowserBridgeError } from "../../utils/errors.js";
import type { AgentFailureCode } from "../../kernels/agent/agentTypes.js";
import type { NativeErrorCode } from "../../types/nativeErrorCodes.js";

export function agentError(code: AgentFailureCode, message: string, details: Record<string, unknown> = {}): BrowserBridgeError {
	// Native enum lacks agent façade codes; construct with INVALID_RULE then override top-level
	// `code` so CLI/daemon envelopes surface CONTEXT_EXPIRED / REF_STALE / etc. for agent callers.
	const error = new BrowserBridgeError("INVALID_RULE" as NativeErrorCode, message, {
		...details,
		code,
		agentCode: code,
		agentFacade: true,
		nativeCode: "INVALID_RULE",
	});
	Object.defineProperty(error, "code", {
		value: code,
		writable: false,
		enumerable: true,
		configurable: true,
	});
	return error;
}
