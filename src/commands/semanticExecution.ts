import type { AbmlActionContext } from "../kernels/abml/actionOutcome.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserOperationSemanticEvidence, BrowserOperationTarget } from "../kernels/session/browserOperation.js";

export type {
	BrowserOperationBusinessResult,
	BrowserOperationSemanticEvidence,
	BrowserOperationSemanticWindow,
} from "../kernels/session/browserOperation.js";

export type SemanticExecutionPrepareInput = {
	operationId: string;
	deadlineAt: number;
	signal: AbortSignal;
};

export type SemanticExecutionSettleInput = SemanticExecutionPrepareInput & {
	dispatchFinishedAt: number;
	terminalHint: "verified" | "query" | "declared-failure" | "unverified-mutation";
};

export type SemanticExecutionSettlement = {
	semantic: BrowserOperationSemanticEvidence;
	expectedRevision: number;
	deadlineReached?: boolean;
};

export interface SemanticExecutionProvider {
	prepare(input: SemanticExecutionPrepareInput): Promise<void>;
	beforeDispatch(input: SemanticExecutionPrepareInput): Promise<void>;
	actionEventBoundary(): number | undefined;
	settle(input: SemanticExecutionSettleInput): Promise<SemanticExecutionSettlement>;
}

export type SemanticExecutionProviderFactory = (input: {
	server: BrowserCommandRuntimePort;
	target: BrowserOperationTarget;
	action: AbmlActionContext;
}) => SemanticExecutionProvider | undefined;
