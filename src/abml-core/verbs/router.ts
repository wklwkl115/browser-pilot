import type { Entity } from "../entity.js";
import type { EntityDiff, EntityDiffOptions } from "../diff.js";
import type { ActionabilityReport, RefDescriptor, VerificationResult } from "../types.js";
import { isActionVerb, type AbmlActionVerb } from "../actionabilityModel.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlRuntimeContext = {
	now?: () => number;
	read?: (input: AbmlReadInput) => Promise<AbmlVerbResult>;
	click?: (input: AbmlClickInput) => Promise<AbmlVerbResult>;
	type?: (input: AbmlTypeInput) => Promise<AbmlVerbResult>;
	scroll?: (input: AbmlScrollInput) => Promise<AbmlVerbResult>;
	pierce?: (input: AbmlPierceInput) => Promise<AbmlVerbResult>;
	frame?: (input: AbmlFrameInput) => Promise<AbmlVerbResult>;
};

export type AbmlReadInput = {
	ref?: RefDescriptor | string;
	plane?: "structure" | "network" | "event";
	depth?: number;
	filter?: Record<string, unknown>;
	baseline?: Entity[];
	diffOptions?: EntityDiffOptions;
	prefetchedScan?: Record<string, unknown>;
	axCacheKey?: string;
};

export type AbmlClickInput = {
	ref: RefDescriptor | string;
	button?: "left" | "middle" | "right";
	count?: number;
	diff?: boolean;
	actionability?: ActionabilityReport;
	verification?: VerificationResult;
};

export type AbmlTypeInput = {
	ref: RefDescriptor | string;
	text: string;
	clear?: boolean;
	diff?: boolean;
	actionability?: ActionabilityReport;
	verification?: VerificationResult;
};

export type AbmlScrollInput = {
	ref?: RefDescriptor | string;
	to?: "top" | "bottom" | "next" | "previous" | { x?: number; y?: number };
	steps?: number;
	collect?: boolean;
	verification?: VerificationResult;
};

export type AbmlPierceInput = {
	ref: RefDescriptor | string;
	depth?: number;
};

export type AbmlFrameInput = {
	ref?: RefDescriptor | string;
	depth?: number;
};

export type AbmlVerbRequest =
	| { verb: "read"; input: AbmlReadInput }
	| { verb: "click"; input: AbmlClickInput }
	| { verb: "type"; input: AbmlTypeInput }
	| { verb: "scroll"; input: AbmlScrollInput }
	| { verb: "pierce"; input: AbmlPierceInput }
	| { verb: "frame"; input: AbmlFrameInput };

export type AbmlVerbSuccess = {
	ok: true;
	verb: string;
	data?: Record<string, unknown>;
	entities?: Entity[];
	diff?: EntityDiff;
	actionability?: ActionabilityReport;
	verification?: VerificationResult;
	nextActions?: string[];
	meta?: Record<string, unknown>;
};

export type AbmlVerbFailure = {
	ok: false;
	verb: string;
	error: ReturnType<typeof normalizeAbmlError>;
	nextActions?: string[];
	meta?: Record<string, unknown>;
};

export type AbmlVerbResult = AbmlVerbSuccess | AbmlVerbFailure;

export function actionabilityFailure(verb: AbmlActionVerb, report: ActionabilityReport): AbmlVerbFailure {
	const blockerCodes = new Set(report.blockers.map((item) => item.code));
	const code = blockerCodes.has("occluded") ? "TARGET_OCCLUDED"
		: blockerCodes.has("disabled") ? "TARGET_DISABLED"
			: blockerCodes.has("not_editable") ? "TARGET_NOT_EDITABLE"
				: "ACTIONABILITY_TIMEOUT";
	const error = normalizeAbmlError({ code, message: `${verb} actionability failed` }, { actionability: report });
	return { ok: false, verb, error, nextActions: error.recovery.nextActions, meta: { blockerCount: report.blockers.length } };
}

export function verificationFailure(verb: string, verification: VerificationResult): AbmlVerbFailure {
	const code = verification.status === "inconclusive" ? "VERIFY_INCONCLUSIVE" : "VERIFY_FAILED";
	const error = normalizeAbmlError({ code, message: `${verb} verification ${verification.status}` }, { verification });
	return { ok: false, verb, error, nextActions: error.recovery.nextActions };
}

export function isAbmlActionVerb(value: string): value is AbmlActionVerb {
	return isActionVerb(value);
}
