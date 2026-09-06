import { randomUUID } from "node:crypto";
import path from "node:path";
import type { VerificationResult } from "../kernels/abml/types.js";
import { BrowserBridgeError, compactError } from "../utils/errors.js";
import { isRecord } from "../utils/records.js";
import type { OperationRequestEvent, OperationTrace } from "./operationContext.js";

export type AssertionResult = VerificationResult & {
	operationId: string;
	scope: "assertion";
	checkedAt: number;
};

export type BusinessResult = {
	status: "succeeded" | "failed" | "unknown";
	reasonCode: "not_declared" | "unproven" | "conflicting_conditions" | "success_observed" | "failure_observed";
	reason: string;
	checkedAt: number;
	success?: AssertionResult;
	failure?: AssertionResult;
};

export type ExecutionReceipt = {
	status: "not_dispatched" | "dispatched_unknown" | "returned";
	/** A successful browser response does not establish business success. */
	response?: "success" | "error";
	acknowledged?: boolean;
	dispatchedAt?: number;
	returnedAt?: number;
};

export type OperationSnapshot = {
	operationId: string;
	verb: string;
	createdAt: number;
	expiresAt: number;
	active: boolean;
	execution: ExecutionReceipt;
	verification?: AssertionResult;
	business: BusinessResult;
	recovery: { action: "retry_after_review" | "observe_only"; automaticReplay: false };
	evidence?: { resourceUri: string };
	continuation?: { available: boolean; reason?: string };
};

export type OperationRecord = OperationTrace & {
	projectRoot: string;
	view: OperationSnapshot;
	requests: OperationRequestEvent[];
	/** Contains observation logic only, never the original mutating command. */
	wait?: (waitMs: number, signal?: AbortSignal) => Promise<void>;
};

export function assertionResult(operationId: string, value: VerificationResult): AssertionResult {
	return { ...value, operationId, scope: "assertion", checkedAt: Date.now() };
}

export function unknownBusiness(reason?: string): BusinessResult {
	return {
		status: "unknown",
		reasonCode: reason === undefined ? "not_declared" : "unproven",
		reason: reason ?? "No business success or failure condition was declared",
		checkedAt: Date.now(),
	};
}

export function businessResult(success?: AssertionResult, failure?: AssertionResult): BusinessResult {
	const checks = { ...(success ? { success } : {}), ...(failure ? { failure } : {}) };
	if (success?.status === "verified" && failure?.status === "verified")
		return {
			...unknownBusiness("Declared success and failure conditions conflict"),
			reasonCode: "conflicting_conditions",
			...checks,
		};
	if (failure?.status === "verified")
		return {
			status: "failed",
			reasonCode: "failure_observed",
			reason: "Declared failure condition was observed",
			checkedAt: Date.now(),
			...checks,
		};
	if (success?.status === "verified" && (!failure || failure.status === "unmet"))
		return {
			status: "succeeded",
			reasonCode: "success_observed",
			reason: "Declared success condition was observed; this claim is limited to its evidence",
			checkedAt: Date.now(),
			...checks,
		};
	return { ...unknownBusiness("Business outcome is not established by the available evidence"), ...checks };
}

/** Per-command-host, bounded, volatile observation records. IDs are correlation, not idempotency keys. */
export class OperationRegistry {
	private readonly records = new Map<string, OperationRecord>();

	constructor(
		private readonly maxEntries = 256,
		private readonly ttlMs = 30 * 60_000,
	) {}

	create(verb: string, projectRoot: string, requestedId?: string): OperationRecord {
		this.prune();
		if (
			requestedId !== undefined &&
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)
		)
			throw new BrowserBridgeError("INVALID_RULE", "Invalid operation ID");
		const existing = requestedId ? this.records.get(requestedId) : undefined;
		if (existing)
			throw new BrowserBridgeError(
				"INVALID_RULE",
				"Operation ID already exists; inspect its receipt instead of replaying it",
				{
					...(existing.projectRoot === path.resolve(projectRoot) ? { operation: existing.view } : {}),
				},
			);
		if (this.records.size >= this.maxEntries) {
			const idle = [...this.records.values()].find((record) => !record.view.active);
			if (idle) this.records.delete(idle.operationId);
			else throw new BrowserBridgeError("QUEUE_FULL", "Operation registry is full; wait for active operations");
		}
		const operationId = requestedId ?? randomUUID();
		const createdAt = Date.now();
		const view: OperationSnapshot = {
			operationId,
			verb,
			createdAt,
			expiresAt: createdAt + this.ttlMs,
			active: true,
			execution: { status: "not_dispatched" },
			business: unknownBusiness(),
			recovery: { action: "observe_only", automaticReplay: false },
		};
		const record: OperationRecord = {
			operationId,
			projectRoot: path.resolve(projectRoot),
			view,
			requests: [],
			request: (event) => {
				const existing = record.requests.findIndex((item) => item.requestId === event.requestId);
				if (existing >= 0) record.requests[existing] = { ...event };
				else record.requests.push({ ...event });
				if (record.requests.length > 128) record.requests.shift();
				if (event.phase !== "dispatch") return;
				if (event.dispatchStarted === false && event.ackAt === undefined) {
					view.execution = { status: "not_dispatched", acknowledged: false };
					view.recovery.action = "retry_after_review";
					return;
				}
				view.execution = {
					status: event.response && event.outcomeKnown !== false ? "returned" : "dispatched_unknown",
					dispatchedAt: event.sentAt,
					acknowledged: event.ackAt !== undefined,
					...(event.response
						? {
								response: event.response,
								...(event.outcomeKnown !== false ? { returnedAt: event.finishedAt } : {}),
							}
						: {}),
				};
				view.recovery.action = "observe_only";
			},
		};
		this.records.set(operationId, record);
		return record;
	}

	get(operationId: string, projectRoot: string): OperationRecord {
		this.prune();
		const record = this.records.get(operationId);
		if (!record || record.projectRoot !== path.resolve(projectRoot))
			throw new BrowserBridgeError(
				"HANDLE_NOT_FOUND",
				"Operation is unavailable, expired, or belongs to another project; do not replay the write",
			);
		return record;
	}

	private prune(): void {
		for (const [id, record] of this.records)
			if (!record.view.active && record.view.expiresAt <= Date.now()) this.records.delete(id);
	}
}

export function recordDispatchFailure(record: OperationRecord, error: unknown): void {
	if (record.view.execution.status === "returned") return;
	const normalized = compactError(error);
	const details = isRecord(normalized.details) ? normalized.details : {};
	// No ACK alone never proves non-delivery. Only an explicit non-dispatch report can do so.
	if (details.dispatchStarted === false && record.view.execution.acknowledged !== true) {
		record.view.execution = { status: "not_dispatched", acknowledged: false };
		record.view.recovery.action = "retry_after_review";
	} else {
		record.view.execution.status = "dispatched_unknown";
		record.view.recovery.action = "observe_only";
	}
}
