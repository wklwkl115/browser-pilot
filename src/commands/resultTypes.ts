import type { DetailLevel } from "../utils/params.js";
import type { Fact, FactGranularity, FactPlane, FactRendering, FactSalience } from "../kernels/evidence/distill/fact.js";

export type CommandFactGranularity = FactGranularity;
export type CommandFactPlane = FactPlane;
export type CommandFactSalience = FactSalience;
export type CommandFactRendering = FactRendering;
export type CommandFact = Fact;

export type DistilledSummary = Record<string, unknown>;

export type DistilledEnvelope = {
	tool: string;
	command?: string;
	browserSessionId?: string;
	detailLevel: DetailLevel;
	summary: DistilledSummary;
	diagnostics?: Record<string, unknown>;
	target?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	privacy?: Record<string, unknown>;
	entities?: Array<Record<string, unknown>>;
	abmlIntegrated?: boolean;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	relations?: Record<string, unknown>;
	identity?: Record<string, unknown>;
	inference?: Record<string, unknown>;
	diff?: Record<string, unknown>;
	causal?: Record<string, unknown>;
	templates?: Array<Record<string, unknown>>;
	treeDiff?: Record<string, unknown>;
	snapshotProjection?: Record<string, unknown>;
	collections?: Array<Record<string, unknown>>;
	error?: Record<string, unknown>;
	nextActions?: string[];
	correlation?: Record<string, unknown>;
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	activeContext?: Record<string, unknown>;
	artifact_hints?: Record<string, unknown>;
	saved?: Record<string, unknown>;
	evidence?: CommandEvidenceEnvelope;
	renderer?: "salience-v1";
	delta?: "session";
	baselineSnapshotId?: string;
};

export type CommandEvidenceSummaryBlock = {
	kind: string;
	text?: string;
	name?: string;
	value?: unknown;
	path?: string;
};

export type CommandEvidenceArtifactHint = {
	path: string;
	kind?: string;
	bytes?: number;
	chars?: number;
	privacy?: string;
};

export type CommandEvidenceResourceHint = {
	uri: string;
	kind?: string;
	etag?: string;
};

export type CommandEvidenceRecoveryHint = {
	code?: string;
	message: string;
	command?: string;
	argv?: string[];
};

export type CommandEvidenceEnvelope = {
	summary: CommandEvidenceSummaryBlock[];
	runtimeRefs: string[];
	artifacts: CommandEvidenceArtifactHint[];
	resources: CommandEvidenceResourceHint[];
	recovery: CommandEvidenceRecoveryHint[];
	redaction?: {
		applied: boolean;
		fields?: string[];
	};
};

export type CommandEvidenceEnvelopeInput = {
	summary?: Record<string, unknown>;
	runtimeRefs?: string[];
	artifact?: Record<string, unknown>;
	resources?: CommandEvidenceResourceHint[];
	recoveryActions?: string[];
	redactionApplied?: boolean;
	redactionFields?: string[];
};

export function emptyCommandEvidenceEnvelope(): CommandEvidenceEnvelope {
	return {
		summary: [],
		runtimeRefs: [],
		artifacts: [],
		resources: [],
		recovery: [],
	};
}

export function buildCommandEvidenceEnvelope(input: CommandEvidenceEnvelopeInput): CommandEvidenceEnvelope {
	const envelope = emptyCommandEvidenceEnvelope();
	if (input.summary && Object.keys(input.summary).length) {
		envelope.summary.push({ kind: "summary", value: input.summary });
	}
	for (const ref of input.runtimeRefs ?? []) {
		if (ref && !envelope.runtimeRefs.includes(ref)) envelope.runtimeRefs.push(ref);
	}
	if (input.artifact && typeof input.artifact.path === "string") {
		envelope.artifacts.push({
			path: input.artifact.path,
			kind: typeof input.artifact.kind === "string" ? input.artifact.kind : undefined,
			bytes: typeof input.artifact.bytes === "number" ? input.artifact.bytes : undefined,
			chars: typeof input.artifact.chars === "number" ? input.artifact.chars : undefined,
			privacy: typeof input.artifact.privacy === "string" ? input.artifact.privacy : undefined,
		});
	}
	envelope.resources.push(...(input.resources ?? []));
	for (const action of input.recoveryActions ?? []) {
		envelope.recovery.push({ message: action });
	}
	if (input.redactionApplied || input.redactionFields?.length) {
		envelope.redaction = {
			applied: input.redactionApplied === true,
			...(input.redactionFields?.length ? { fields: input.redactionFields } : {}),
		};
	}
	return envelope;
}
