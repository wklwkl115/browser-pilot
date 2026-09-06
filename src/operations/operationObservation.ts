import { setTimeout as delay } from "node:timers/promises";
import { compactError } from "../utils/errors.js";
import { createCodedError } from "../utils/codedError.js";
import { isRecord } from "../utils/records.js";
import { saveTextArtifact, artifactResourceUri } from "../artifacts/artifactFiles.js";
import { stableJson } from "../utils/json.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import { inOperationPhase } from "./operationContext.js";
import {
	assertionResult,
	businessResult,
	unknownBusiness,
	type OperationRecord,
	type AssertionResult,
	type BusinessResult,
} from "./operationRegistry.js";
import { evaluateCondition, conditionResult, type ConditionRuntime } from "./conditionRuntime.js";
import type { BusinessConditions, DeclarativeCondition } from "./conditionSchema.js";

export type ObservationPlan = {
	runtime: Omit<ConditionRuntime, "signal">;
	expect?: DeclarativeCondition;
	business?: BusinessConditions;
};

export async function persistOperation(record: OperationRecord): Promise<void> {
	try {
		const saved = await saveTextArtifact(
			{ cwd: record.projectRoot },
			undefined,
			`operation-${record.operationId}.json`,
			stableJson({ ...record.view, requests: record.requests }),
		);
		const resourceUri = artifactResourceUri(saved.path, record.projectRoot);
		if (resourceUri) record.view.evidence = { resourceUri };
	} catch {
		// Failure to persist evidence must not reclassify or replay an already executed operation.
		delete record.view.evidence;
	}
}

export async function operationFailure(error: unknown, record?: OperationRecord): Promise<unknown> {
	if (!record) return error;
	record.view.active = false;
	if (record.view.execution.status === "not_dispatched") record.view.recovery.action = "retry_after_review";
	await persistOperation(record);
	const normalized = compactError(error);
	return createCodedError({
		name: "BrowserOperationError",
		code: String(normalized.code),
		message: String(normalized.message),
		details: {
			...(isRecord(normalized.details) ? normalized.details : {}),
			operation: record.view,
		},
	});
}

async function abortableObservation<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let rejectAbort!: (reason: unknown) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = () => rejectAbort(new Error("Observation was cancelled or its budget expired"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([run(), aborted]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

type ConditionSample = { verification?: AssertionResult; business?: BusinessResult };

async function sampleConditions(
	record: OperationRecord,
	plan: ObservationPlan,
	runtime: ConditionRuntime,
	sample: ConditionSample,
	legacyVerify?: (runtime: ConditionRuntime) => Promise<VerificationResult>,
) {
	const verification = plan.expect ? await evaluateCondition(plan.expect, runtime) : await legacyVerify?.(runtime);
	runtime.signal?.throwIfAborted();
	if (verification) sample.verification = assertionResult(record.operationId, verification);
	const success = plan.business?.success
		? assertionResult(record.operationId, await evaluateCondition(plan.business.success, runtime))
		: undefined;
	const failure = plan.business?.failure
		? assertionResult(record.operationId, await evaluateCondition(plan.business.failure, runtime))
		: undefined;
	runtime.signal?.throwIfAborted();
	if (plan.business) sample.business = businessResult(success, failure);
	return sample;
}

export async function observeOperation(
	record: OperationRecord,
	plan: ObservationPlan,
	waitMs: number,
	signal?: AbortSignal,
	legacyVerify?: (runtime: ConditionRuntime) => Promise<VerificationResult>,
): Promise<void> {
	const startedAt = Date.now();
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	const timer = setTimeout(() => controller.abort(), waitMs);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	let pollMs = 100;
	let reading = false;
	let completedSamples = 0;
	let partial: ConditionSample = {};
	try {
		while (!controller.signal.aborted) {
			const runtime = {
				...plan.runtime,
				signal: controller.signal,
				timeoutMs: Math.max(1, waitMs - (Date.now() - startedAt)),
			};
			reading = true;
			partial = {};
			const sample = await inOperationPhase(record, "verify", () =>
				abortableObservation(
					() => sampleConditions(record, plan, runtime, partial, legacyVerify),
					controller.signal,
				),
			);
			controller.signal.throwIfAborted();
			if (sample.verification)
				record.view.verification = {
					...sample.verification,
					elapsedMs: Date.now() - startedAt,
				};
			if (sample.business) record.view.business = sample.business;
			completedSamples++;
			reading = false;
			const assertionDone =
				(!plan.expect && !legacyVerify) ||
				record.view.verification?.status === "verified" ||
				record.view.verification?.retryable === false;
			const businessDone =
				!plan.business ||
				record.view.business.status !== "unknown" ||
				record.view.business.reasonCode === "conflicting_conditions";
			if (assertionDone && businessDone) return;
			await delay(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - startedAt))), undefined, {
				signal: controller.signal,
			});
			pollMs = Math.min(1000, pollMs * 2);
		}
	} catch {
		if (partial.verification) record.view.verification = partial.verification;
		if (!controller.signal.aborted || (reading && completedSamples === 0)) {
			if (!partial.verification && (plan.expect || legacyVerify))
				record.view.verification = assertionResult(
					record.operationId,
					conditionResult(plan.runtime.verb, "inconclusive", {}, {}, "Postcondition observation failed"),
				);
			if (plan.business) record.view.business = unknownBusiness("Business evidence could not be read");
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		if (signal?.aborted) {
			if (plan.expect || legacyVerify)
				record.view.verification = assertionResult(
					record.operationId,
					conditionResult(
						plan.runtime.verb,
						"inconclusive",
						{},
						{},
						"Observation was cancelled; the write was not undone",
					),
				);
			if (plan.business)
				record.view.business = unknownBusiness("Business observation was cancelled; the write was not undone");
		}
		if (record.view.verification && (plan.expect || legacyVerify))
			record.view.verification.elapsedMs = Math.max(0, Date.now() - startedAt);
	}
}

/** Deliberately receives only an observation plan. A continuation cannot access the write callback. */
export function attachOperationWait(record: OperationRecord, plan: ObservationPlan): void {
	record.view.continuation = {
		available: !!(plan.expect || plan.business),
		...(!plan.expect && !plan.business
			? { reason: "No resumable declarative conditions; inspect business state with read-only tools" }
			: {}),
	};
	record.wait = async (waitMs, signal) => {
		if (record.view.execution.status === "not_dispatched") return;
		if (!plan.expect && !plan.business) return;
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		const timer = setTimeout(() => controller.abort(), waitMs);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		const startedAt = Date.now();
		const run = () => {
			// The outer timer bounds queue acquisition only. Observation owns its remaining budget,
			// so exhausting that budget is not mistaken for cancellation by the caller.
			clearTimeout(timer);
			return observeOperation(record, plan, Math.max(1, waitMs - (Date.now() - startedAt)), controller.signal);
		};
		try {
			const { server, tabId, browserSessionId, rawTarget } = plan.runtime;
			if (server.withTargetTransaction && tabId !== undefined)
				await server.withTargetTransaction(
					{ browserSessionId, tabId, targetRef: rawTarget, signal: controller.signal },
					run,
				);
			else await run();
		} catch {
			if (plan.business)
				record.view.business = unknownBusiness(
					"Continued observation could not acquire its target within the budget",
				);
			if (plan.expect)
				record.view.verification = assertionResult(
					record.operationId,
					conditionResult(
						plan.runtime.verb,
						"inconclusive",
						{},
						{},
						"Continued observation could not acquire its target",
					),
				);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	};
}
