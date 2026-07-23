import type { RefDescriptor as SharedRefDescriptor, RefKind as SharedRefKind, RefLocator } from "../refs/types.js";
import type { EntityDiff } from "./diff.js";

export type Locator = RefLocator;
export type RefKind = SharedRefKind;
export type RefDescriptor = SharedRefDescriptor;

export type VerificationStatus = "verified" | "unmet" | "inconclusive";

export type VerificationResult = {
	status: VerificationStatus;
	verb: string;
	expected?: Record<string, unknown>;
	observed: Record<string, unknown>;
	evidence: Array<{ kind: string; summary: string; ref?: string; data?: Record<string, unknown> }>;
	elapsedMs: number;
	diff?: EntityDiff;
};
