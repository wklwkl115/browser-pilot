import { collectRefs } from "../kernels/refs/text.js";
import { buildCommandEvidenceEnvelope, type CommandEvidenceEnvelope } from "./resultTypes.js";
import { isRecord } from "./summaries/common.js";

export function buildResultEvidence(input: {
	summary: Record<string, unknown>;
	entities?: Array<Record<string, unknown>>;
	nextActions?: string[];
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	artifact?: Record<string, unknown>;
	memorySource?: Record<string, unknown>;
	redactionApplied: boolean;
}): CommandEvidenceEnvelope {
	return buildCommandEvidenceEnvelope({
		summary: input.summary,
		runtimeRefs: collectRefs({ summary: input.summary, entities: input.entities, nextActions: input.nextActions, operation: input.operation, snapshot: input.snapshot }),
		artifact: input.artifact,
		recoveryActions: input.nextActions,
		memory: isRecord(input.memorySource) ? input.memorySource : undefined,
		redactionApplied: input.redactionApplied,
	});
}
