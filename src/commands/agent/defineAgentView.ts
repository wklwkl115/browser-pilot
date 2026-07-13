import { Type } from "typebox";
import { defineBrowserCommand, inlineJsonCommandResult, runCommandHandler, commandTimeoutMs, commandMaxChars } from "../commandRuntime.js";
import { strictCommandParameters, type CommandRegistrarContext } from "../commandShared.js";
import type { ValidationIssue } from "../commandDefinition.js";
import {
	agentContextPort,
	contextSummary,
	ensureRuntimeReady,
	listTargetCandidates,
	projectAndBindView,
	resolveAgentOwner,
	runCanonicalObserve,
} from "./agentFacadeRuntime.js";
import { agentError } from "./agentErrors.js";
import { isRecord } from "../../utils/records.js";

function validateViewArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (args.target !== undefined && !isRecord(args.target)) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/target", message: "target must be an object" });
	}
	if (args.detail !== undefined && args.detail !== "decision" && args.detail !== "expanded") {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/detail", message: "detail must be decision or expanded" });
	}
	if (args.ifContextRevision !== undefined && (typeof args.ifContextRevision !== "number" || !Number.isInteger(args.ifContextRevision))) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/ifContextRevision", message: "ifContextRevision must be an integer" });
	}
	return issues;
}

export function defineAgentViewCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_view",
		label: "Browser View",
		description: "Agent façade: ensure readiness, observe the page, and return a compact AgentViewV1 with contextRef and candidate aliases.",
		promptSnippet: "Call browser_view to obtain contextRef and decision-oriented candidates without tabId/pageEpoch/paths.",
		promptGuidelines: [
			"Omit contextRef to create a new mechanical context; reuse contextRef for subsequent turns.",
			"Use target.use=list then target.tabRef to select tabs; never pass raw tabId.",
			"Default detail=decision; use expanded only when needed.",
		],
		parameters: strictCommandParameters({
			contextRef: Type.Optional(Type.String({ description: "Existing mechanical context handle" })),
			target: Type.Optional(Type.Object({
				use: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("current"), Type.Literal("list")])),
				tabRef: Type.Optional(Type.String()),
			}, { additionalProperties: false })),
			focus: Type.Optional(Type.Object({
				text: Type.Optional(Type.String()),
				roles: Type.Optional(Type.Array(Type.String())),
				include: Type.Optional(Type.Array(Type.Union([
					Type.Literal("notices"),
					Type.Literal("forms"),
					Type.Literal("navigation"),
					Type.Literal("content"),
				]))),
			}, { additionalProperties: false })),
			detail: Type.Optional(Type.Union([Type.Literal("decision"), Type.Literal("expanded")])),
			maxChars: Type.Optional(Type.Number()),
			timeoutMs: Type.Optional(Type.Number()),
			ifContextRevision: Type.Optional(Type.Number()),
		}),
		validateArguments: validateViewArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const owner = resolveAgentOwner(ctx);
				const port = agentContextPort();
				const server = await ensureStarted();
				await ensureRuntimeReady(server);

				const timeoutMs = commandTimeoutMs(params.timeoutMs, 30_000);
				const maxChars = commandMaxChars(params, "browser_observe");

				let record = params.contextRef
					? port.get(String(params.contextRef), owner)
					: port.create(owner);
				if ("error" in record) {
					throw agentError(record.error, `browser_view failed: ${record.error}`);
				}

				if (params.ifContextRevision !== undefined && record.revision !== params.ifContextRevision) {
					throw agentError("CONTEXT_REVISION_MISMATCH", "context revision mismatch", {
						expected: params.ifContextRevision,
						actual: record.revision,
						context: contextSummary(record, true),
					});
				}

				const target = isRecord(params.target) ? params.target : undefined;
				if (target?.use === "list") {
					const targets = listTargetCandidates(server, record);
					return inlineJsonCommandResult({
						schema: "browser-agent-view/v1",
						context: contextSummary(record),
						page: { changed: false },
						summary: `${targets.length} target(s)`,
						notices: [],
						candidates: [],
						targets,
						decision: targets.length
							? { kind: "choose_action", candidateRefs: [] }
							: { kind: "blocked", reason: "no_targets" },
						limits: { cost: { chars: 0, bytes: 0, estimatedTokens: 0 } },
						trace: { available: false, unavailableReason: "list_only" },
					}, { action: "list_targets", contextRef: record.id }, params, "browser_observe");
				}

				let tabId: number | undefined;
				let targetRef: string | undefined;
				if (typeof target?.tabRef === "string") {
					const binding = port.resolveTarget(record, target.tabRef);
					if ("error" in binding) throw agentError("REF_STALE", `unknown tabRef ${target.tabRef}`);
					targetRef = binding.targetLineageRef;
					tabId = binding.tabId;
					record.targetLineageRef = binding.targetLineageRef;
					port.setState(record, "anchored");
				}

				const observation = await runCanonicalObserve(server, { tabId, targetRef, timeoutMs });
				const targets = target?.use === "list" ? undefined : listTargetCandidates(server, record);
				const view = projectAndBindView({
					observation,
					record,
					detail: params.detail === "expanded" ? "expanded" : "decision",
					maxChars,
					targets,
				});

				return inlineJsonCommandResult(view, {
					action: "view",
					contextRef: record.id,
					contextRevision: record.revision,
				}, params, "browser_observe");
			});
		},
	});
}
