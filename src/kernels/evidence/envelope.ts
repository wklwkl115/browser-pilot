export type EvidenceSummaryBlock = {
	kind: string;
	text?: string;
	name?: string;
	value?: unknown;
	path?: string;
};

export type EvidenceArtifactHint = {
	path: string;
	kind?: string;
	bytes?: number;
	chars?: number;
	privacy?: string;
};

export type EvidenceResourceHint = {
	uri: string;
	kind?: string;
	etag?: string;
};

export type EvidenceRecoveryHint = {
	code?: string;
	message: string;
	command?: string;
	argv?: string[];
};

export type EvidenceEnvelope = {
	summary: EvidenceSummaryBlock[];
	runtimeRefs: string[];
	artifacts: EvidenceArtifactHint[];
	resources: EvidenceResourceHint[];
	recovery: EvidenceRecoveryHint[];
	memory: EvidenceResourceHint[];
	redaction?: {
		applied: boolean;
		fields?: string[];
	};
};

export type CommandResult<T> = {
	data: T;
	evidence: EvidenceEnvelope;
};

export type EvidenceEnvelopeInput = {
	summary?: Record<string, unknown>;
	runtimeRefs?: string[];
	artifact?: Record<string, unknown>;
	resources?: EvidenceResourceHint[];
	recoveryActions?: string[];
	memory?: Record<string, unknown>;
	redactionApplied?: boolean;
	redactionFields?: string[];
};

export function emptyEvidenceEnvelope(): EvidenceEnvelope {
	return {
		summary: [],
		runtimeRefs: [],
		artifacts: [],
		resources: [],
		recovery: [],
		memory: [],
	};
}

export function buildEvidenceEnvelope(input: EvidenceEnvelopeInput): EvidenceEnvelope {
	const envelope = emptyEvidenceEnvelope();
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
