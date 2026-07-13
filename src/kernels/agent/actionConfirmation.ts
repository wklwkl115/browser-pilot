/**
 * Pure action-confirmation binding model for agent façade writes.
 * Digest material must never include passwords/tokens/secret field values.
 */

import type { PageIdentity } from "../session/pageIdentity.js";
import type { SemanticActionV1 } from "./agentTypes.js";

export type ActionConfirmationDecision =
	| { kind: "authorized" }
	| { kind: "required"; reason: string }
	| { kind: "mismatch"; reason: string }
	| { kind: "expired" }
	| { kind: "consumed" };

export type ActionConfirmationRecord = {
	confirmationRef: string;
	ownerPairingDigest: string;
	contextRefDigest: string;
	contextRevision: number;
	pageIdentityDigest: string;
	semanticActionDigest: string;
	reason: string;
	expiresAt: number;
	consumedAt?: number;
};

/** Redacted action fields used for digest equivalence (no secret values). */
export function redactedSemanticActionForDigest(action: SemanticActionV1): Record<string, unknown> {
	const base: Record<string, unknown> = { kind: action.kind };
	if ("ref" in action && action.ref) base.ref = action.ref;
	if ("fromRef" in action) base.fromRef = action.fromRef;
	if ("toRef" in action) base.toRef = action.toRef;
	if ("key" in action && action.key) base.key = action.key;
	if ("modifiers" in action && action.modifiers) base.modifiers = action.modifiers;
	if ("direction" in action && action.direction) base.direction = action.direction;
	if ("amount" in action && action.amount) base.amount = action.amount;
	if ("url" in action && action.url) {
		// Host + path only; strip query (may hold tokens).
		try {
			const u = new URL(action.url);
			base.url = `${u.protocol}//${u.host}${u.pathname}`;
		} catch {
			base.url = "[invalid-url]";
		}
	}
	if ("disposition" in action && action.disposition) base.disposition = action.disposition;
	if ("replace" in action) base.replace = action.replace === true;
	// fill value: length + kind only, never plaintext secret
	if (action.kind === "fill") {
		base.valueLength = action.value.length;
		base.valueKind = "text";
	}
	if (action.kind === "select") {
		base.valueLength = action.value.length;
		base.valueKind = "choice";
	}
	return base;
}

export function pageIdentityDigestMaterial(identity: PageIdentity | undefined): string {
	if (!identity) return "identity:none";
	return `identity:${identity.browserSessionId}:${identity.tabId}:${identity.targetGeneration}:${identity.pageEpoch}`;
}

export function actionRequiresConfirmation(input: {
	action: SemanticActionV1;
	candidateRisk?: "normal" | "sensitive" | "irreversible";
	forceSensitive?: boolean;
}): { required: boolean; reason: string } {
	if (input.forceSensitive) return { required: true, reason: "force_sensitive" };
	if (input.candidateRisk === "irreversible") return { required: true, reason: "irreversible_control" };
	if (input.candidateRisk === "sensitive") return { required: true, reason: "sensitive_control" };
	if (input.action.kind === "submit") return { required: true, reason: "form_submit" };
	if (input.action.kind === "navigate") return { required: true, reason: "navigation" };
	return { required: false, reason: "normal" };
}

export function verifyActionConfirmation(input: {
	record: ActionConfirmationRecord | undefined;
	now: number;
	ownerPairingDigest: string;
	contextRefDigest: string;
	contextRevision: number;
	pageIdentityDigest: string;
	semanticActionDigest: string;
}): ActionConfirmationDecision {
	const { record } = input;
	if (!record) return { kind: "mismatch", reason: "confirmation_not_found" };
	if (record.consumedAt !== undefined) return { kind: "consumed" };
	if (input.now > record.expiresAt) return { kind: "expired" };
	if (record.ownerPairingDigest !== input.ownerPairingDigest) return { kind: "mismatch", reason: "owner_mismatch" };
	if (record.contextRefDigest !== input.contextRefDigest) return { kind: "mismatch", reason: "context_mismatch" };
	if (record.contextRevision !== input.contextRevision) return { kind: "mismatch", reason: "revision_mismatch" };
	if (record.pageIdentityDigest !== input.pageIdentityDigest) return { kind: "mismatch", reason: "page_identity_mismatch" };
	if (record.semanticActionDigest !== input.semanticActionDigest) return { kind: "mismatch", reason: "action_mismatch" };
	return { kind: "authorized" };
}
