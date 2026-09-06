import type { OperationRequestEvent } from "./operationContext.js";
import type { ExecutionReceipt } from "./operationRegistry.js";

function receipt(event: OperationRequestEvent): ExecutionReceipt {
	if (event.dispatchStarted === false && event.ackAt === undefined) return { status: "not_dispatched" };
	return {
		status: event.response && event.outcomeKnown !== false ? "returned" : "dispatched_unknown",
		dispatchedAt: event.sentAt,
		acknowledged: event.ackAt !== undefined,
		...(event.response && event.outcomeKnown !== false
			? { response: event.response, returnedAt: event.finishedAt }
			: {}),
	};
}

function combine(a: ExecutionReceipt, b: ExecutionReceipt): ExecutionReceipt {
	if (a.status === "not_dispatched") return b;
	if (b.status === "not_dispatched") return a;
	const unknown = a.status === "dispatched_unknown" || b.status === "dispatched_unknown";
	return {
		status: unknown ? "dispatched_unknown" : "returned",
		acknowledged: a.acknowledged === true || b.acknowledged === true,
		dispatchedAt: Math.min(a.dispatchedAt ?? Infinity, b.dispatchedAt ?? Infinity),
		...(!unknown
			? {
					response: a.response === "error" || b.response === "error" ? "error" : "success",
					returnedAt: b.returnedAt,
				}
			: {}),
	};
}

/** Bounded evidence with a conservative summary that survives request eviction. */
export class OperationExecution {
	private readonly requests = new Map<string, ExecutionReceipt>();
	private folded: ExecutionReceipt = { status: "not_dispatched" };
	private ended = false;

	request(event: OperationRequestEvent): ExecutionReceipt | undefined {
		if (event.phase !== "dispatch" || event.accessMode === "read") return undefined;
		this.requests.set(event.requestId, receipt(event));
		if (this.requests.size > 128) {
			const [id, oldest] = this.requests.entries().next().value!;
			this.folded = combine(this.folded, oldest);
			this.requests.delete(id);
		}
		return this.snapshot();
	}

	finish(success: boolean, notDispatched = false, acknowledged?: boolean): ExecutionReceipt {
		this.ended = true;
		const result = this.snapshot();
		// An unexplained outer failure may follow an untracked write; prior success is not proof of completion.
		if (!success && !notDispatched && result.status === "returned" && result.response !== "error") {
			this.folded = { ...result, status: "dispatched_unknown", response: undefined, returnedAt: undefined };
			return this.folded;
		}
		if (result.status !== "not_dispatched") return result;
		if (!success && notDispatched) return { status: "not_dispatched", acknowledged: false };
		this.folded = success
			? { status: "returned", response: "success", acknowledged, returnedAt: Date.now() }
			: { status: "dispatched_unknown" };
		return this.folded;
	}

	private snapshot(): ExecutionReceipt {
		let result = this.folded;
		for (const value of this.requests.values()) result = combine(result, value);
		// A child response cannot establish completion of its enclosing dispatch callback.
		return !this.ended && result.status === "returned"
			? { ...result, status: "dispatched_unknown", returnedAt: undefined }
			: result;
	}
}
