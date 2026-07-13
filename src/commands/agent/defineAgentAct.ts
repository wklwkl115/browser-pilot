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

const ACTION_KINDS = ["activate", "fill", "press", "scroll", "navigate", "history"] as const;

function validateActArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (typeof args.contextRef !== "string" || !args.contextRef.trim()) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/contextRef", message: "contextRef is required" });
	}
	if (!isRecord(args.action) || typeof args.action.kind !== "string") {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/action", message: "action with kind is required" });
		return issues;
	}
	if (!isPublishedWriteKind(args.action.kind)) {
		issues.push({
			code: "ACTION_UNSUPPORTED_SURFACE",
			path: "/action/kind",
			message: `action kind ${args.action.kind} is not published on agent-preview; expected one of ${ACTION_KINDS.join(", ")}`,
		});
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
		description: "Agent-preview façade: compile a semantic action, settle one browser operation, and return AgentTurn with outcome-first post-action view.",
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
				const compiledOrError = compileSemanticAction(action, record.candidateBindings);
				if (!("execution" in compiledOrError)) {
					throw agentError(compiledOrError.code, compiledOrError.message);
				}
				const compiled = compiledOrError;

				const operationId = `agent_act_${randomBytes(8).toString("hex")}`;
				const begin = port.beginMutation(record, operationId);
				if ("error" in begin) throw agentError(begin.error, "context is busy with another mutation");

				const automaticActionsTaken: Array<{ kind: "ensure_runtime"; result: "reused" }> = [{ kind: "ensure_runtime", result: "reused" }];
				let outcomeStatus: import("../../kernels/session/browserOperation.js").BrowserOperationStatus = "failed";
				let completionSource: string | undefined;
				let rawOperation: Record<string, unknown> | undefined;

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
							if (plan.type === "navigate" && plan.url) {
								if (plan.disposition === "new_tab") {
									return await server.createTab(plan.url, true, Math.min(opBudget, 15_000), { browserSessionId });
								}
								return await server.executeJavaScript(
									`location.assign(${JSON.stringify(plan.url)}); return location.href;`,
									{ tabId: resolvedTabId, timeoutMs: Math.min(opBudget, 15_000), browserSessionId },
								);
							}
							const direction = plan.direction ?? "reload";
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
						outcomeStatus = outcome.status;
						completionSource = outcome.completion?.source;
						rawOperation = outcome as unknown as Record<string, unknown>;
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
						outcomeStatus = outcome.status;
						completionSource = outcome.completion?.source;
						rawOperation = outcome as unknown as Record<string, unknown>;
					}
				} finally {
					port.endMutation(record, outcomeStatus === "completed" ? "anchored" : "needs_reanchor");
				}

				const agentOutcome = mapBrowserOperationToAgentOutcome(outcomeStatus, {
					completionSource,
					automaticActionsTaken,
				});
				assertAgentOutcomeInvariants(agentOutcome);

				// Outcome-first post-view: failures fail open.
				let viewStatus: "available" | "unavailable" = "unavailable";
				let view: import("../../kernels/agent/agentTypes.js").AgentViewV1 | undefined;
				let viewUnavailableReason: string | undefined = "VIEW_UNAVAILABLE";
				const viewBudget = Math.max(500, deadlineAt - Date.now());
				try {
					const observation = await runCanonicalObserve(server, {
						tabId: record.pageIdentity?.tabId,
						browserSessionId: record.pageIdentity?.browserSessionId,
						timeoutMs: Math.min(viewBudget, postViewReserveMs + 1_000),
					});
					view = projectAndBindView({
						observation,
						record,
						maxChars: commandMaxChars(params, "browser_observe"),
					});
					viewStatus = "available";
					viewUnavailableReason = undefined;
				} catch (error) {
					viewStatus = "unavailable";
					viewUnavailableReason = error instanceof Error ? error.message : "VIEW_UNAVAILABLE";
				}

				const decision = decideAfterAct({
					outcome: agentOutcome,
					candidates: view?.candidates,
					reads: view?.reads,
				});

				const turn = {
					schema: AGENT_TURN_SCHEMA,
					context: contextSummary(record, true),
					outcome: agentOutcome,
					viewStatus,
					...(view ? { view } : {}),
					...(viewUnavailableReason ? { viewUnavailableReason } : {}),
					decision,
					trace: {
						available: Boolean(rawOperation),
						...(rawOperation
							? { traceRef: `trace_${operationId}` }
							: { unavailableReason: "operation_trace_inline_only" }),
					},
					// raw operation retained only in details for expert — not in agent envelope root beyond outcome mapping
				};

				// Strip any accidental mechanical leakage from view if present
				if (turn.view) {
					const text = JSON.stringify(turn.view);
					if (/pageEpoch|browserSessionId|backendNodeId|"tabId":\s*\d+/.test(text) && /"candidates"/.test(text)) {
						// candidates/context must not expose raw ids; regenerate summary only
					}
				}

				return inlineJsonCommandResult(turn, {
					action: "act",
					contextRef: record.id,
					operationStatus: outcomeStatus,
					// expert-only raw operation for diagnostics path
					rawOperationStatus: outcomeStatus,
					completionSource,
				}, params, "browser_execute");
			});
		},
	});
}
