export type CommandFactGranularity = "full" | "compact" | "line" | "ref" | "omit";

export type CommandFactPlane = "entity" | "outline" | "relation" | "causal" | "diff" | "treeDiff" | "snapshot" | "identity" | "summary" | "diagnostic";

export type CommandFactSalience = {
	actionability?: number;
	novelty?: number;
	consequence?: number;
	structure?: number;
	relevance?: number;
};

export type CommandFactRendering = {
	value?: unknown;
	text?: string;
	cost: number;
};

export type CommandFact = {
	ref: string;
	plane: CommandFactPlane;
	salience: CommandFactSalience;
	renderings: Partial<Record<Exclude<CommandFactGranularity, "omit">, CommandFactRendering>>;
};

export type CommandDistilledSummary = Record<string, unknown>;

export type CommandBudgetedEnvelope = {
	tool: string;
	command?: string;
	browserSessionId?: string;
	detailLevel: unknown;
	summary: CommandDistilledSummary;
	diagnostics?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	privacy?: Record<string, unknown>;
	entities?: Array<Record<string, unknown>>;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	relations?: Record<string, unknown>;
	identity?: Record<string, unknown>;
	diff?: Record<string, unknown>;
	causal?: Record<string, unknown>;
	treeDiff?: Record<string, unknown>;
	snapshotProjection?: Record<string, unknown>;
	collections?: Array<Record<string, unknown>>;
	nextActions?: string[];
	saved?: Record<string, unknown>;
	[key: string]: unknown;
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
	memory: CommandEvidenceResourceHint[];
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
	memory?: Record<string, unknown>;
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
		memory: [],
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
	if (input.memory && Object.keys(input.memory).length) {
		const uri = typeof input.memory.uri === "string" ? input.memory.uri : "browser-memory://index";
		envelope.memory.push({ uri, kind: "memory" });
	}
	if (input.redactionApplied || input.redactionFields?.length) {
		envelope.redaction = {
			applied: input.redactionApplied === true,
			...(input.redactionFields?.length ? { fields: input.redactionFields } : {}),
		};
	}
	return envelope;
}
