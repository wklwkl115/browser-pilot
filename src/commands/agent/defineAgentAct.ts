import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { defineBrowserCommand, inlineJsonCommandResult, runCommandHandler, commandTimeoutMs, commandMaxChars, resolveLocalTargetTabId } from "../commandRuntime.js";
import { strictCommandParameters, type CommandRegistrarContext } from "../commandShared.js";
import type { ValidationIssue } from "../commandDefinition.js";
import { withBrowserOperation } from "../browserOperation.js";
import { executeProgram } from "../../browser-command-runtime/programEngine.js";
import { compileSemanticAction } from "../../browser-command-runtime/semanticActionCompiler.js";
import { mapBrowserOperationToAgentOutcome, assertAgentOutcomeInvariants } from "../../kernels/agent/agentOutcome.js";
import { decideAfterAct } from "../../kernels/agent/agentDecision.js";
import { AGENT_TURN_SCHEMA, type SemanticActionV1 } from "../../kernels/agent/agentTypes.js";
import { isPublishedWriteKind } from "../../kernels/agent/semanticAction.js";
import { isRecord } from "../../utils/records.js";
import {
	agentContextPort,
	contextSummary,
	ensureRuntimeReady,
	projectAndBindView,
	resolveAgentOwner,
	runCanonicalObserve,
} from "./agentFacadeRuntime.js";
import { agentError } from "./agentErrors.js";
import { failClosedAgentView } from "./agentEnvelopeSanitize.js";
import { getActionConfirmationService, semanticActionDigest } from "../../apps/daemon/ActionConfirmationService.js";
import { getAgentTraceStore } from "../../apps/daemon/AgentTraceStore.js";
import { pageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { identityFromObservation } from "../../kernels/agent/agentView.js";
import { classifyRecovery, mayAutoReplayMutation } from "../../kernels/agent/recoveryPolicy.js";

const ACTION_KINDS = ["activate", "fill", "press", "scroll", "select", "drag", "submit", "navigate", "history"] as const;
const SCROLL_DIRS = new Set(["up", "down", "left", "right"]);
const HISTORY_DIRS = new Set(["back", "forward", "reload"]);

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateActArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (typeof args.contextRef !== "string" || !args.contextRef.trim()) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/contextRef", message: "contextRef is required" });
	}
	if (!isRecord(args.action) || typeof args.action.kind !== "string") {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action", message: "action with kind is required" });
		return issues;
	}
	const action = args.action;
	const kind = action.kind;
	if (typeof kind !== "string" || !isPublishedWriteKind(kind)) {
		issues.push({
			code: "ACTION_UNSUPPORTED_SURFACE",
			path: "/action/kind",
			message: `action kind ${String(kind)} is not published on agent façade; expected one of ${ACTION_KINDS.join(", ")}`,
		});
		return issues;
	}
	if (kind === "activate" && !nonEmptyString(action.ref)) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/ref", message: "activate requires action.ref" });
	}
	if (kind === "fill") {
		if (!nonEmptyString(action.ref)) issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/ref", message: "fill requires action.ref" });
		if (typeof action.value !== "string") issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/value", message: "fill requires action.value string" });
	}
	if (kind === "press" && !nonEmptyString(action.key)) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/key", message: "press requires action.key" });
	}
	if (kind === "scroll" && (typeof action.direction !== "string" || !SCROLL_DIRS.has(action.direction))) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/direction", message: "scroll requires direction up|down|left|right" });
	}
	if (kind === "navigate" && !nonEmptyString(action.url)) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/url", message: "navigate requires a non-empty action.url" });
	}
	if (kind === "history" && (typeof action.direction !== "string" || !HISTORY_DIRS.has(action.direction))) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/direction", message: "history requires direction back|forward|reload" });
	}
	if (kind === "select") {
		if (!nonEmptyString(action.ref)) issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/ref", message: "select requires action.ref" });
		if (typeof action.value !== "string" || !action.value.trim()) {
			issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/value", message: "select requires non-empty action.value" });
		}
	}
	if (kind === "drag") {
		if (!nonEmptyString(action.fromRef)) issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/fromRef", message: "drag requires fromRef" });
		if (!nonEmptyString(action.toRef)) issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/toRef", message: "drag requires toRef" });
	}
	if (kind === "submit" && !nonEmptyString(action.ref)) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action/ref", message: "submit requires action.ref" });
	}
	return issues;
}

function remainingBudget(deadlineAt: number, reserveMs: number): number {
	return Math.max(0, deadlineAt - Date.now() - reserveMs);
}

export function defineAgentActCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_act",
		label: "Browser Act",
		description: "Agent façade: compile a semantic action, settle one browser operation, and return AgentTurn with outcome-first post-action view.",
		promptSnippet: "Call browser_act once per mutation with contextRef and a semantic action; do not wait/sleep or replay after ACK.",
		promptGuidelines: [
			"Use candidate refs from the latest browser_view/browser_act view only.",
			"completed is the only success; never treat effect_observed as success.",
			"Do not auto-retry mutations after acknowledgement.",
		],
		parameters: strictCommandParameters({
			contextRef: Type.String(),
			action: Type.Object({
				kind: Type.String(),
				ref: Type.Optional(Type.String()),
				value: Type.Optional(Type.String()),
				replace: Type.Optional(Type.Boolean()),
				key: Type.Optional(Type.String()),
				modifiers: Type.Optional(Type.Array(Type.String())),
				direction: Type.Optional(Type.String()),
				amount: Type.Optional(Type.String()),
				fromRef: Type.Optional(Type.String()),
				toRef: Type.Optional(Type.String()),
				url: Type.Optional(Type.String()),
				disposition: Type.Optional(Type.String()),
			}, { additionalProperties: false }),
			confirmationRef: Type.Optional(Type.String()),
			maxChars: Type.Optional(Type.Number()),
			timeoutMs: Type.Optional(Type.Number()),
			ifContextRevision: Type.Optional(Type.Number()),
		}),
		validateArguments: validateActArguments,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const owner = resolveAgentOwner(ctx);
				const port = agentContextPort();
				const startedAt = Date.now();
				const totalTimeoutMs = commandTimeoutMs(params.timeoutMs, 30_000);
				const deadlineAt = startedAt + totalTimeoutMs;
				const postViewReserveMs = Math.min(4_000, Math.floor(totalTimeoutMs * 0.2));

				const record = port.get(String(params.contextRef), owner);
				if ("error" in record) throw agentError(record.error, `browser_act failed: ${record.error}`);
				if (params.ifContextRevision !== undefined && record.revision !== params.ifContextRevision) {
					throw agentError("CONTEXT_REVISION_MISMATCH", "context revision mismatch", {
						expected: params.ifContextRevision,
						actual: record.revision,
						context: contextSummary(record, true),
					});
				}

				const server = await ensureStarted();
				await ensureRuntimeReady(server);

				const action = params.action as SemanticActionV1;
				const revisionBefore = record.revision;
				const automaticActionsTaken: Array<{ kind: "ensure_runtime"; result: "reused" } | { kind: "reanchor_page"; reason: string }> = [
					{ kind: "ensure_runtime", result: "reused" },
				];
				const maxChars = commandMaxChars(params, "browser_observe");

				if (record.state === "ambiguous") {
					throw agentError("TARGET_AMBIGUOUS", "target lineage is ambiguous; choose tab via browser_view");
				}

				// Pre-dispatch identity preflight: observe current page and stop before mutation on identity change.
				const preflightBudget = Math.min(remainingBudget(deadlineAt, postViewReserveMs + 2_000), 8_000);
				if (preflightBudget < 500) {
					throw agentError("INVALID_AGENT_REQUEST", "insufficient budget for pre-dispatch identity preflight");
				}
				let preObservation: import("../../kernels/abml/pageObservation.js").PageObservationV3 | undefined;
				try {
					preObservation = await runCanonicalObserve(server, {
						tabId: record.pageIdentity?.tabId,
						browserSessionId: record.pageIdentity?.browserSessionId,
						timeoutMs: preflightBudget,
					});
				} catch {
					// If observe fails, still allow act only when context has no prior identity (first bind).
					if (record.pageIdentity) {
						throw agentError("RUNTIME_NOT_READY", "pre-dispatch observe failed; cannot prove page identity");
					}
				}
				if (preObservation) {
					const currentIdentity = identityFromObservation(preObservation);
					const reanchorReason = pageReanchorReason(record.pageIdentity, currentIdentity);
					if (reanchorReason) {
						const recovery = classifyRecovery({
							condition: reanchorReason === "target_replaced"
								? "unique_target_replacement_pre_dispatch"
								: "page_identity_changed_pre_dispatch",
							dispatchBoundary: "prepared",
						});
						// Always stop mutation with old refs; re-anchor and return fresh view.
						port.applyIdentity(record, currentIdentity, reanchorReason);
						automaticActionsTaken.push({ kind: "reanchor_page", reason: reanchorReason });
						const freshView = projectAndBindView({
							observation: preObservation,
							record,
							maxChars,
						});
						const safeView = failClosedAgentView(freshView as unknown as Record<string, unknown>) as unknown as typeof freshView;
						const blockedTurn = {
							schema: AGENT_TURN_SCHEMA,
							context: contextSummary(record, true),
							outcome: {
								classification: "inconclusive" as const,
								status: "ambiguous" as const,
								completionVerified: false,
								ok: false,
								code: "IDENTITY_CHANGED",
								replay: "do_not_retry" as const,
								automaticActionsTaken,
							},
							viewStatus: "available" as const,
							view: safeView,
							decision: decideAfterAct({
								outcome: {
									classification: "inconclusive",
									status: "ambiguous",
									completionVerified: false,
									ok: false,
									replay: "do_not_retry",
									automaticActionsTaken,
								},
								candidates: safeView.candidates,
								reads: safeView.reads,
							}),
							trace: { available: false, unavailableReason: "not_dispatched_identity_changed" },
							recovery: { action: recovery.action, mutationReplay: recovery.mutationReplay, reason: reanchorReason },
						};
						return inlineJsonCommandResult(blockedTurn, {
							action: "act",
							code: "IDENTITY_CHANGED",
							reanchorReason,
							dispatched: false,
						}, params, "browser_execute");
					}
					// Keep preObservation for post-view reuse when identity stable.
					if (!record.pageIdentity && currentIdentity) {
						port.applyIdentity(record, currentIdentity);
					}
				}

				const compiledOrError = compileSemanticAction(action, record.candidateBindings);
				if (!("execution" in compiledOrError)) {
					// Stale/missing candidate ref after rebind → REF_STALE / ACTION_NOT_ALLOWED
					throw agentError(compiledOrError.code, compiledOrError.message);
				}
				const compiled = compiledOrError;

				// Stale binding identity vs context anchor
				for (const binding of compiled.targetBindings) {
					const mismatch = pageReanchorReason(binding.pageIdentity, record.pageIdentity);
					if (mismatch) {
						throw agentError("REF_STALE", `candidate binding identity stale: ${mismatch}`, {
							ref: binding.ref,
							reanchorReason: mismatch,
						});
					}
				}

				// Action confirmation (sensitive/submit/navigate)
				const confirmSvc = getActionConfirmationService();
				const candidateRef = "ref" in action && typeof action.ref === "string" ? action.ref : undefined;
				const candidateRisk = candidateRef
					? record.candidateBindings.get(candidateRef)?.risk
					: undefined;
				const needConfirm = confirmSvc.requiresConfirmation({
					action,
					candidateRisk,
				});
				const requiresConfirm = needConfirm.required || compiled.safety.requiresConfirmation;
				if (requiresConfirm) {
					const confirmationRef = typeof params.confirmationRef === "string" ? params.confirmationRef : undefined;
					if (!confirmationRef) {
						const minted = confirmSvc.mint({
							owner,
							contextRef: record.id,
							contextRevision: record.revision,
							pageIdentity: record.pageIdentity,
							action,
							reason: needConfirm.reason || compiled.safety.confirmationReason || "sensitive_action",
						});
						const blockedTurn = {
							schema: AGENT_TURN_SCHEMA,
							context: contextSummary(record, false),
							outcome: {
								classification: "failure" as const,
								status: "failed" as const,
								completionVerified: false,
								ok: false,
								code: "CONFIRMATION_REQUIRED",
								replay: "do_not_retry" as const,
								automaticActionsTaken,
							},
							viewStatus: "unavailable" as const,
							viewUnavailableReason: "CONFIRMATION_REQUIRED",
							decision: {
								kind: "confirm" as const,
								confirmationRef: minted.confirmationRef,
								reason: minted.reason,
							},
							trace: { available: false, unavailableReason: "not_dispatched" },
						};
						return inlineJsonCommandResult(blockedTurn, {
							action: "act",
							code: "CONFIRMATION_REQUIRED",
							confirmationRef: minted.confirmationRef,
						}, params, "browser_execute");
					}
					const decision = confirmSvc.consume({
						confirmationRef,
						owner,
						contextRef: record.id,
						contextRevision: record.revision,
						pageIdentity: record.pageIdentity,
						action,
					});
					if (decision.kind === "expired") throw agentError("CONFIRMATION_MISMATCH", "confirmation expired", { decision: "expired" });
					if (decision.kind === "consumed") throw agentError("CONFIRMATION_CONSUMED", "confirmation already consumed");
					if (decision.kind === "mismatch") throw agentError("CONFIRMATION_MISMATCH", `confirmation mismatch: ${decision.reason}`, { decision });
				}

				// Deny identical mutation re-dispatch after ACK until identity re-anchor clears the marker.
				const actionDigest = semanticActionDigest(action);
				if (record.lastAckedActionDigest === actionDigest && !mayAutoReplayMutation("acked")) {
					throw agentError("INVALID_AGENT_REQUEST", "mutation already acknowledged; do not replay", {
						code: "MUTATION_REPLAY_DENIED",
						replay: "do_not_retry",
						actionDigest,
					});
				}

				const operationId = `agent_act_${randomBytes(8).toString("hex")}`;
				const begin = port.beginMutation(record, operationId);
				if ("error" in begin) throw agentError(begin.error, "context is busy with another mutation", { code: "CONTEXT_BUSY" });

				let outcomeStatus: import("../../kernels/session/browserOperation.js").BrowserOperationStatus = "failed";
				let completionSource: string | undefined;
				let rawOperation: Record<string, unknown> | undefined;
				let dispatchBoundary: "not_started" | "prepared" | "sent_unacked" | "acked" | "terminal" = "prepared";

				try {
					const opBudget = remainingBudget(deadlineAt, postViewReserveMs);
					if (opBudget < 1_000) {
						throw agentError("INVALID_AGENT_REQUEST", "insufficient budget remaining before dispatch", {
							remainingMs: opBudget,
						});
					}

					const tabId = record.pageIdentity?.tabId;
					const browserSessionId = record.pageIdentity?.browserSessionId;
					const resolvedTabId = tabId !== undefined
						? resolveLocalTargetTabId(server, tabId, browserSessionId)
						: resolveLocalTargetTabId(server, undefined, browserSessionId);

					if (compiled.execution.kind === "navigation") {
						const plan = compiled.execution.plan;
						if (plan.type === "navigate") {
							const url = typeof plan.url === "string" ? plan.url.trim() : "";
							if (!url) throw agentError("INVALID_AGENT_REQUEST", "navigate requires a non-empty url");
						} else if (plan.type === "history") {
							const direction = plan.direction;
							if (direction !== "back" && direction !== "forward" && direction !== "reload") {
								throw agentError("INVALID_AGENT_REQUEST", "history requires direction back|forward|reload");
							}
						} else {
							throw agentError("INVALID_AGENT_REQUEST", "unknown navigation plan type");
						}
						const outcome = await withBrowserOperation({
							server,
							commandName: plan.type === "navigate" && plan.disposition === "new_tab" ? "browser_tabs" : "browser_execute",
							command: plan.type === "navigate" ? (plan.disposition === "new_tab" ? "create" : "javascript") : "javascript",
							action: plan.type === "navigate" && plan.disposition === "new_tab" ? "create" : undefined,
							mode: plan.type === "navigate" && plan.disposition === "new_tab" ? undefined : "javascript",
							semanticCompletionResolverId: compiled.completionResolverId,
							browserSessionId,
							tabId: resolvedTabId,
							timeoutMs: opBudget,
							ctx,
							onUpdate,
						}, async () => {
							if (plan.type === "navigate") {
								const url = plan.url!.trim();
								if (plan.disposition === "new_tab") {
									return await server.createTab(url, true, Math.min(opBudget, 15_000), { browserSessionId });
								}
								return await server.executeJavaScript(
									`location.assign(${JSON.stringify(url)}); return location.href;`,
									{ tabId: resolvedTabId, timeoutMs: Math.min(opBudget, 15_000), browserSessionId },
								);
							}
							// plan.type === "history" — never fall through from navigate
							const direction = plan.direction as "back" | "forward" | "reload";
							const code = direction === "back"
								? "history.back(); return location.href;"
								: direction === "forward"
									? "history.forward(); return location.href;"
									: "location.reload(); return location.href;";
							return await server.executeJavaScript(code, {
								tabId: resolvedTabId,
								timeoutMs: Math.min(opBudget, 15_000),
								browserSessionId,
							});
						});
						// withBrowserOperation always arms+dispatches; treat return as post-dispatch (sent/acked).
						const acked = outcome.dispatch?.acknowledged === true || outcome.dispatch?.started === true;
						dispatchBoundary = acked ? "acked" : "sent_unacked";
						if (acked && !mayAutoReplayMutation("acked")) {
							record.lastAckedActionDigest = actionDigest;
						}
						outcomeStatus = outcome.status;
						completionSource = outcome.completion?.source;
						rawOperation = outcome as unknown as Record<string, unknown>;
						dispatchBoundary = "terminal";
					} else {
						const program = compiled.execution.program;
						const outcome = await withBrowserOperation({
							server,
							commandName: "browser_execute",
							command: "program",
							mode: "program",
							physicalProgram: compiled.physical,
							semanticCompletionResolverId: compiled.completionResolverId,
							browserSessionId,
							tabId: resolvedTabId,
							timeoutMs: opBudget,
							ctx,
							onUpdate,
						}, async () => executeProgram(program, {
							server,
							tabId: resolvedTabId,
							browserSessionId,
							targetRef: undefined,
							refRegistry: {},
							contextVars: new Map(),
							lastEvalResult: undefined,
							signal: signal ?? new AbortController().signal,
							evalTimeoutMs: opBudget,
						}));
						// Program results rarely set acknowledged=true; started means dispatch crossed the boundary.
						const acked = outcome.dispatch?.acknowledged === true || outcome.dispatch?.started === true;
						dispatchBoundary = acked ? "acked" : "sent_unacked";
						if (acked && !mayAutoReplayMutation("acked")) {
							record.lastAckedActionDigest = actionDigest;
						}
						outcomeStatus = outcome.status;
						completionSource = outcome.completion?.source;
						rawOperation = outcome as unknown as Record<string, unknown>;
						dispatchBoundary = "terminal";
					}
				} finally {
					port.endMutation(record, outcomeStatus === "completed" ? "anchored" : "needs_reanchor");
					if (record.lastAckedActionDigest === actionDigest) {
						record.lastAckedAtRevision = record.revision;
					}
				}

				// Outcome-first post-view: failures fail open; never rewrite settled outcome.
				let viewStatus: "available" | "unavailable" = "unavailable";
				let view: import("../../kernels/agent/agentTypes.js").AgentViewV1 | undefined;
				let viewUnavailableReason: string | undefined = "VIEW_UNAVAILABLE";
				const settledStatus = outcomeStatus;
				const viewBudget = Math.max(500, deadlineAt - Date.now());
				try {
					// Prefer a fresh post-action observe; fall back to preflight only if budget is exhausted.
					const observation = viewBudget >= 800
						? await runCanonicalObserve(server, {
							tabId: record.pageIdentity?.tabId,
							browserSessionId: record.pageIdentity?.browserSessionId,
							timeoutMs: Math.min(viewBudget, postViewReserveMs + 1_000),
						})
						: preObservation ?? await runCanonicalObserve(server, {
							tabId: record.pageIdentity?.tabId,
							browserSessionId: record.pageIdentity?.browserSessionId,
							timeoutMs: Math.min(1_000, postViewReserveMs),
						});
					const currentIdentity = identityFromObservation(observation);
					const reanchor = pageReanchorReason(record.pageIdentity, currentIdentity);
					if (reanchor) {
						port.applyIdentity(record, currentIdentity, reanchor);
						automaticActionsTaken.push({ kind: "reanchor_page", reason: reanchor });
					}
					view = projectAndBindView({
						observation,
						record,
						maxChars,
					});
					viewStatus = "available";
					viewUnavailableReason = undefined;
				} catch (error) {
					viewStatus = "unavailable";
					viewUnavailableReason = error instanceof Error ? error.message : "VIEW_UNAVAILABLE";
				}
				// Guard: post-view cannot change settled operation status
				outcomeStatus = settledStatus;

				const agentOutcome = mapBrowserOperationToAgentOutcome(outcomeStatus, {
					completionSource,
					automaticActionsTaken,
				});
				assertAgentOutcomeInvariants(agentOutcome);

				const decision = decideAfterAct({
					outcome: agentOutcome,
					candidates: view?.candidates,
					reads: view?.reads,
				});

				const safeView = view
					? (failClosedAgentView(view as unknown as Record<string, unknown>) as unknown as typeof view)
					: undefined;

				// Trace fail-open
				const traceStore = getAgentTraceStore();
				const traced = traceStore.record({
					contextRef: record.id,
					owner,
					contextRevisionBefore: revisionBefore,
					contextRevisionAfter: record.revision,
					requestSummary: {
						actionKind: action.kind,
						confirmation: Boolean(params.confirmationRef),
					},
					compiledPlanSummary: {
						kind: compiled.actionKind,
						frames: compiled.debugPlan.frames,
						physical: compiled.physical,
						resolverId: compiled.completionResolverId,
					},
					rawOperationRef: typeof rawOperation?.operationId === "string" ? rawOperation.operationId : operationId,
					automaticActionsTaken,
					projectionReport: {
						candidatesConsidered: safeView?.candidates.length ?? 0,
						candidatesReturned: safeView?.candidates.length ?? 0,
						readsBound: safeView?.reads?.length ?? 0,
						chars: safeView?.limits.cost.chars ?? 0,
						bytes: safeView?.limits.cost.bytes ?? 0,
						estimatedTokens: safeView?.limits.cost.estimatedTokens ?? 0,
					},
				});
				const trace = traced.ok
					? { available: true as const, traceRef: traced.record.traceRef }
					: { available: false as const, unavailableReason: traced.reason };
				if (traced.ok) record.lastTraceRef = traced.record.traceRef;

				const turn = {
					schema: AGENT_TURN_SCHEMA,
					context: contextSummary(record, true),
					outcome: agentOutcome,
					viewStatus,
					...(safeView ? { view: safeView } : {}),
					...(viewUnavailableReason ? { viewUnavailableReason } : {}),
					decision: safeView
						? decideAfterAct({
							outcome: agentOutcome,
							candidates: safeView.candidates,
							reads: safeView.reads,
						})
						: decision,
					trace,
				};

				return inlineJsonCommandResult(turn, {
					action: "act",
					contextRef: record.id,
					operationStatus: outcomeStatus,
					rawOperationStatus: outcomeStatus,
					completionSource,
					dispatchBoundary,
				}, params, "browser_execute");
			});
		},
	});
}
