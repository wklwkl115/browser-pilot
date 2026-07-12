import type { Entity } from "../entity.js";
import type { EntityDiff, EntityDiffOptions } from "../diff.js";
import type { ActionabilityReport, RefDescriptor, VerificationResult } from "../types.js";
import { normalizeAbmlError } from "../errors.js";
import type { PageWorldScanBundleV1 } from "../pageWorldScan.js";

export type AbmlRuntimeContext = {
	now?: () => number;
	read?: (input: AbmlReadInput) => Promise<AbmlVerbResult>;
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
	prefetchedScan?: PageWorldScanBundleV1;
	axCacheKey?: string;
};

export type AbmlPierceInput = {
	ref: RefDescriptor | string;
	depth?: number;
};

export type AbmlFrameInput = {
	ref?: RefDescriptor | string;
	depth?: number;
};

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
