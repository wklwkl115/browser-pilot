import { BrowserBridgeError } from "../../utils/errors.js";
import type { AgentFailureCode } from "../../kernels/agent/agentTypes.js";
import type { NativeErrorCode } from "../../types/nativeErrorCodes.js";

export function agentError(code: AgentFailureCode, message: string, details: Record<string, unknown> = {}): BrowserBridgeError {
	// Agent failure codes are public façade codes; map through INVALID_RULE for native enum compatibility
	// while preserving the stable agent code on details.code and the error code string for tests.
	return new BrowserBridgeError("INVALID_RULE" as NativeErrorCode, message, {
		...details,
		code,
		agentCode: code,
		agentFacade: true,
	});
}
