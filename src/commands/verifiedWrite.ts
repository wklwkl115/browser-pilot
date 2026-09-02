import { prepareAbmlVerification } from "../browser-command-runtime/abml/verification.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import { withBrowserOperation, type BrowserOperationDispatchContext } from "./browserOperation.js";
import { withCommandEffect, type CommandEffect } from "./commandEffect.js";
import { javascriptVerificationResult, type PreparedCommandExpectation } from "./commandExpectation.js";

/**
 * One write pipeline for every tool that mutates a tab: serialize on the target, bracket the
 * dispatch with page fingerprints for `effect`, and settle the caller's `expect` postcondition
 * into `verification`. `browser_execute` and `browser_command` differ only in how they dispatch
 * and in what they attach around the bracket, so those parts are injected.
 */

export type VerifiedWriteTarget = { browserSessionId?: string; tabId?: number; rawTarget?: string | number };

export type VerifiedWriteOutcome<T> = { result: T; effect?: CommandEffect; verification?: VerificationResult };

export type VerifiedWriteOptions<T extends BrowserBridgeExecutionResult, Extra> = {
	server: BrowserCommandRuntimePort;
	/** Verb recorded in verification results (tool or native command name). */
	verb: string;
	target: VerifiedWriteTarget;
	timeoutMs: number;
	signal?: AbortSignal;
	expect?: PreparedCommandExpectation;
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
	const { server, target, timeoutMs, signal, verb } = options;
	return await withBrowserOperation(
		{
			server,
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			targetRef: target.rawTarget,
			timeoutMs,
			signal,
		},
		async (context) => {
			// Without a tracked tab there is nothing to fingerprint or verify: dispatch only.
			if (target.tabId === undefined) return { result: await options.dispatch(context) };
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
			const verify =
				abml?.verify ??
				(script
					? async () =>
							javascriptVerificationResult(
								verb,
								(
									await server.executeJavaScript(script, {
										browserSessionId: target.browserSessionId,
										tabId: target.rawTarget,
										timeoutMs,
										accessMode: "read",
										signal: context.signal,
									})
								).data === true,
							)
					: undefined);
			const effected = await withCommandEffect(
				server,
				{
					browserSessionId: target.browserSessionId,
					tabId,
					timeoutMs,
					deadlineAt: context.deadlineAt,
					signal: context.signal,
					...(initialVerification ? { initialVerification } : {}),
					...(verify ? { verify } : {}),
				},
				() => options.dispatch(context),
			);
			const extra = await options.after?.(context, effected);
			return { ...effected, ...(extra !== undefined ? { extra } : {}) };
		},
	);
}

/** Shape the public `{ result, effect?, verification? }` envelope shared by every write tool. */
export function verifiedWriteValue<T extends BrowserBridgeExecutionResult>(
	outcome: VerifiedWriteOutcome<T>,
	effect: CommandEffect | undefined = outcome.effect,
): { result: unknown; effect?: CommandEffect; verification?: VerificationResult } {
	return {
		result: outcome.result.data ?? null,
		...(effect ? { effect } : {}),
		...(outcome.verification ? { verification: outcome.verification } : {}),
	};
}
