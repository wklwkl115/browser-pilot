import { prepareAbmlVerification } from "../browser-command-runtime/abml/verification.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import { withBrowserOperation, type BrowserOperationDispatchContext } from "./browserOperation.js";
import { withCommandEffect, type CommandEffect } from "./commandEffect.js";
import { javascriptVerificationResult, type PreparedCommandExpectation } from "./commandExpectation.js";
import {
	OperationRegistry,
	assertionResult,
	unknownBusiness,
	recordDispatchFailure,
	type OperationRecord,
	type OperationSnapshot,
} from "../operations/operationRegistry.js";
import { inOperationPhase } from "../operations/operationContext.js";
import {
	attachOperationWait,
	observeOperation,
	persistOperation,
	operationFailure,
	type ObservationPlan,
} from "../operations/operationObservation.js";
import { hasDomCondition, readDocumentBaseline, readNetworkBaseline } from "../operations/conditionRuntime.js";
import { hasRequestCondition, type BusinessConditions } from "../operations/conditionSchema.js";
import { BrowserBridgeError } from "../utils/errors.js";

/**
 * One write pipeline for every tool that mutates a tab: serialize on the target, bracket the
 * dispatch with page fingerprints for `effect`, and settle the caller's `expect` postcondition
 * into `verification`. `browser_execute` and `browser_command` differ only in how they dispatch
 * and in what they attach around the bracket, so those parts are injected.
 */

export type VerifiedWriteTarget = { browserSessionId?: string; tabId?: number; rawTarget?: string | number };

export type VerifiedWriteOutcome<T> = {
	result: T;
	effect?: CommandEffect;
	verification?: VerificationResult;
	operation?: OperationSnapshot;
};

export type VerifiedWriteOptions<T extends BrowserBridgeExecutionResult, Extra> = {
	server: BrowserCommandRuntimePort;
	/** Verb recorded in verification results (tool or native command name). */
	verb: string;
	target: VerifiedWriteTarget;
	timeoutMs: number;
	signal?: AbortSignal;
	expect?: PreparedCommandExpectation;
	business?: BusinessConditions;
	verificationWaitMs?: number;
	operations?: OperationRegistry;
	record?: OperationRecord;
	ctx?: { cwd?: string; operationId?: string };
	effects?: boolean;
	/** Page script that evaluates a JavaScript `expect` to a boolean; required when expect.kind is "javascript". */
	verifyScript?: string;
	dispatch: (context: BrowserOperationDispatchContext) => Promise<T>;
	/** Runs inside the target transaction before the effect bracket opens (e.g. visual preflight). */
	before?: (context: BrowserOperationDispatchContext) => Promise<void>;
	/** Runs inside the target transaction after the effect settled; its value is returned as `extra`. */
	after?: (context: BrowserOperationDispatchContext, outcome: VerifiedWriteOutcome<T>) => Promise<Extra>;
};

export async function runVerifiedWrite<T extends BrowserBridgeExecutionResult, Extra = undefined>(
	options: VerifiedWriteOptions<T, Extra>,
): Promise<VerifiedWriteOutcome<T> & { extra?: Extra }> {
	const record =
		options.record ??
		(options.operations ?? new OperationRegistry()).create(
			options.verb,
			options.ctx?.cwd ?? process.cwd(),
			options.ctx?.operationId,
		);
	if (options.business) record.view.business = unknownBusiness("Declared business conditions have not been observed");
	try {
		const outcome = await inOperationPhase(record, "prepare", () => executeVerifiedWrite(options, record));
		record.view.active = false;
		await persistOperation(record);
		return { ...outcome, operation: record.view };
	} catch (error) {
		throw await operationFailure(error, record);
	}
}

async function dispatchRecorded<T extends BrowserBridgeExecutionResult>(
	record: OperationRecord,
	dispatch: () => Promise<T>,
): Promise<T> {
	try {
		const result = await inOperationPhase(record, "dispatch", dispatch);
		record.view.execution = record.executionTrace.finish(true, false, result.acknowledged);
		record.view.recovery.action = "observe_only";
		return result;
	} catch (error) {
		recordDispatchFailure(record, error);
		throw error;
	}
}

async function executeVerifiedWrite<T extends BrowserBridgeExecutionResult, Extra>(
	options: VerifiedWriteOptions<T, Extra>,
	record: OperationRecord,
): Promise<VerifiedWriteOutcome<T> & { extra?: Extra }> {
	const { server, target, timeoutMs, signal, verb } = options;
	const waitMs = options.verificationWaitMs ?? 5_000;
	return await withBrowserOperation(
		{
			server,
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			targetRef: target.rawTarget,
			timeoutMs: timeoutMs + Math.max(0, waitMs - 5_000),
			signal,
		},
		async (context) => {
			// Without a tracked tab there is nothing to fingerprint or verify: dispatch only.
			if (target.tabId === undefined || options.effects === false) {
				if (options.expect || options.business)
					throw new BrowserBridgeError("INVALID_RULE", "Verification requires a tracked browser target");
				return { result: await dispatchRecorded(record, () => options.dispatch(context)) };
			}
			const tabId = target.tabId;
			await options.before?.(context);
			const structured = options.expect?.kind === "abml" ? options.expect.expectation : undefined;
			const abml = structured
				? await prepareAbmlVerification({
						server,
						expectation: structured,
						verb,
						browserSessionId: target.browserSessionId,
						tabId,
						rawTarget: target.rawTarget ?? tabId,
						timeoutMs,
						signal: context.signal,
					})
				: undefined;
			const script = options.expect?.kind === "javascript" ? options.verifyScript : undefined;
			const initialVerification =
				abml?.initialVerification ?? (script ? javascriptVerificationResult(verb) : undefined);
			if (initialVerification)
				record.view.verification = assertionResult(record.operationId, initialVerification);
			const expect =
				options.expect?.kind === "abml"
					? options.expect.expectation
					: options.expect?.kind === "declarative"
						? options.expect.condition
						: undefined;
			const plan: ObservationPlan = {
				runtime: {
					server,
					verb,
					browserSessionId: target.browserSessionId,
					tabId,
					rawTarget: target.rawTarget,
					timeoutMs,
				},
				expect,
				business: options.business,
			};
			const conditions = [expect, options.business?.success, options.business?.failure].filter(
				(item) => item !== undefined,
			);
			if (conditions.some(hasDomCondition))
				plan.runtime.documentBaseline = await readDocumentBaseline({ ...plan.runtime, signal: context.signal });
			if (conditions.some(hasRequestCondition))
				plan.runtime.networkBaseline = await readNetworkBaseline({ ...plan.runtime, signal: context.signal });
			attachOperationWait(record, plan);
			const effected = await withCommandEffect(
				server,
				{
					browserSessionId: target.browserSessionId,
					tabId,
					timeoutMs,
					deadlineAt: context.deadlineAt,
					signal: context.signal,
				},
				() => dispatchRecorded(record, () => options.dispatch(context)),
			);
			const legacyVerify =
				abml?.verify ??
				(script
					? async (runtime: import("../operations/conditionRuntime.js").ConditionRuntime) =>
							javascriptVerificationResult(
								verb,
								(
									await server.executeJavaScript(script, {
										browserSessionId: target.browserSessionId,
										tabId: target.rawTarget,
										timeoutMs: runtime.timeoutMs,
										accessMode: "read",
										signal: runtime.signal,
									})
								).data === true,
							)
					: undefined);
			await observeOperation(
				record,
				{ ...plan, ...(abml ? { expect: undefined } : {}) },
				Math.max(1, Math.min(waitMs, context.deadlineAt - Date.now())),
				context.signal,
				legacyVerify,
			);
			const outcome = {
				...effected,
				...(record.view.verification ? { verification: record.view.verification } : {}),
			};
			const extra = await inOperationPhase(record, "evidence", () => options.after?.(context, outcome));
			return { ...outcome, ...(extra !== undefined ? { extra } : {}) };
		},
	);
}

/** Shape the public `{ result, effect?, verification? }` envelope shared by every write tool. */
export function verifiedWriteValue<T extends BrowserBridgeExecutionResult>(
	outcome: VerifiedWriteOutcome<T>,
	effect: CommandEffect | undefined = outcome.effect,
): Record<string, unknown> {
	return {
		result: outcome.result.data ?? null,
		...(outcome.operation ? operationValue(outcome.operation) : {}),
		...(effect ? { effect } : {}),
		...(outcome.verification ? { verification: outcome.verification } : {}),
	};
}

export function operationValue(operation: OperationSnapshot): Record<string, unknown> {
	return {
		operationId: operation.operationId,
		execution: operation.execution,
		business: operation.business,
		recovery: operation.recovery,
		...(operation.evidence ? { evidence: operation.evidence } : {}),
		...(operation.continuation ? { continuation: operation.continuation } : {}),
	};
}
