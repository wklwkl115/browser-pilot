import { collectRefs } from "../kernels/refs/text.js";
import { buildCommandEvidenceEnvelope, type CommandEvidenceEnvelope } from "./resultTypes.js";

export function buildResultEvidence(input: {
	summary: Record<string, unknown>;
	entities?: Array<Record<string, unknown>>;
	nextActions?: string[];
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	artifact?: Record<string, unknown>;
	redactionApplied: boolean;
}): CommandEvidenceEnvelope {
	return buildCommandEvidenceEnvelope({
		summary: input.summary,
		runtimeRefs: collectRefs({ summary: input.summary, entities: input.entities, nextActions: input.nextActions, operation: input.operation, snapshot: input.snapshot }),
		artifact: input.artifact,
		recoveryActions: input.nextActions,
		redactionApplied: input.redactionApplied,
	});
}
