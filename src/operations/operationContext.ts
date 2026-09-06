import { AsyncLocalStorage } from "node:async_hooks";

export type OperationPhase = "prepare" | "dispatch" | "verify" | "evidence";
export type OperationRequestEvent = {
	requestId: string;
	phase: OperationPhase;
	accessMode?: "read" | "write";
	sentAt: number;
	ackAt?: number;
	finishedAt?: number;
	response?: "success" | "error";
	dispatchStarted?: boolean;
	outcomeKnown?: boolean;
};

export type OperationTrace = {
	operationId: string;
	request(event: OperationRequestEvent): void;
};

const context = new AsyncLocalStorage<{ trace: OperationTrace; phase: OperationPhase }>();

export function inOperationPhase<T>(trace: OperationTrace, phase: OperationPhase, run: () => T): T {
	return context.run({ trace, phase }, run);
}

/** Capture the originating context here: socket callbacks need not run in its async scope. */
export function operationRequest(requestId: string, accessMode: "read" | "write" = "write") {
	const current = context.getStore();
	if (!current) return undefined;
	const event: OperationRequestEvent = {
		requestId,
		accessMode,
		phase: current.phase,
		sentAt: Date.now(),
		dispatchStarted: true,
	};
	return {
		operationId: current.trace.operationId,
		sent: () => current.trace.request(event),
		ack: () => {
			event.ackAt = Date.now();
			current.trace.request(event);
		},
		returned: (response: "success" | "error", dispatchStarted = true, outcomeKnown = true) => {
			event.finishedAt = Date.now();
			event.response = response;
			event.dispatchStarted = dispatchStarted;
			event.outcomeKnown = outcomeKnown;
			current.trace.request(event);
		},
	};
}

export type OperationRequest = ReturnType<typeof operationRequest>;
