import { Type } from "typebox";
import { readBrowserArtifact } from "../../artifacts/artifactReader.js";
import { defineBrowserCommand, inlineJsonCommandResult, runCommandHandler, commandMaxChars } from "../commandRuntime.js";
import { strictCommandParameters, type CommandRegistrarContext } from "../commandShared.js";
import type { ValidationIssue } from "../commandDefinition.js";
import { AGENT_READ_SCHEMA } from "../../kernels/agent/agentTypes.js";
import { measureAgentPayloadCost } from "../../kernels/agent/cognitiveCost.js";
import { agentContextPort, contextSummary, resolveAgentOwner } from "./agentFacadeRuntime.js";
import { agentError } from "./agentErrors.js";

function validateReadArguments(args: Record<string, unknown>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (typeof args.contextRef !== "string" || !args.contextRef.trim()) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/contextRef", message: "contextRef is required" });
	}
	if (typeof args.readRef !== "string" || !args.readRef.trim()) {
		issues.push({ code: "INVALID_AGENT_REQUEST", path: "/readRef", message: "readRef is required" });
	}
	return issues;
}

export function defineAgentReadCommand({ commands }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_read",
		label: "Browser Read",
		description: "Agent-preview façade: read a server-issued readRef without exposing local paths or unverified JSON paths.",
		promptSnippet: "Use browser_read with a readRef from AgentView to fetch windowed verified content.",
		promptGuidelines: [
			"Only use readRef values issued by browser_view/browser_act.",
			"Never invent saved.path or JSON paths.",
		],
		parameters: strictCommandParameters({
			contextRef: Type.String({ description: "Mechanical context handle" }),
			readRef: Type.String({ description: "Server-issued read handle" }),
			offset: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
			maxChars: Type.Optional(Type.Number()),
		}),
		validateArguments: validateReadArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const owner = resolveAgentOwner(ctx);
				const port = agentContextPort();
				const record = port.get(String(params.contextRef), owner);
				if ("error" in record) throw agentError(record.error, `browser_read failed: ${record.error}`);

				const binding = port.resolveRead(record, String(params.readRef));
				if ("error" in binding) throw agentError(binding.error, `browser_read failed: ${binding.error}`);

				const maxChars = commandMaxChars(params, "browser_artifact");
				let data: unknown = binding.descriptor.inlineData ?? null;
				if (binding.descriptor.savedPath) {
					try {
						const artifact = await readBrowserArtifact({
							path: binding.descriptor.savedPath,
							mode: binding.descriptor.jsonPath ? "json" : "text",
							...(binding.descriptor.jsonPath ? { jsonPath: binding.descriptor.jsonPath } : {}),
							offset: typeof params.offset === "number" ? params.offset : 0,
							limit: typeof params.limit === "number" ? params.limit : 40,
							maxChars,
						}, { cwd: ctx?.cwd });
						data = artifact;
					} catch {
						throw agentError("READ_UNAVAILABLE", "verified artifact is unavailable", {
							readRef: binding.readRef,
						});
					}
				}

				const envelope = {
					schema: AGENT_READ_SCHEMA,
					context: contextSummary(record),
					readRef: binding.readRef,
					kind: binding.kind,
					summary: binding.descriptor.description,
					data,
					limits: {
						cost: measureAgentPayloadCost({ data }),
					},
					trace: { available: false, unavailableReason: "trace_metadata_not_persisted" },
				};

				// Ensure no raw path leakage in default envelope fields.
				const serialized = JSON.stringify(envelope);
				if (binding.descriptor.savedPath && serialized.includes(binding.descriptor.savedPath)) {
					// strip accidental path by returning summary-only data marker
					envelope.data = {
						available: true,
						kind: binding.kind,
						windowed: true,
						note: "content redacted path; use expert browser_artifact for raw path debug",
						preview: typeof data === "object" ? data : { text: String(data).slice(0, 500) },
					};
				}

				return inlineJsonCommandResult(envelope, {
					action: "read",
					contextRef: record.id,
					readRef: binding.readRef,
				}, params, "browser_artifact");
			});
		},
	});
}
