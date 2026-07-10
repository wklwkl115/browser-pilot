import type { BrowserPilotRefKind } from "./core.js";

export type BrowserPilotRefPolicy = {
	redaction: "default" | "disabled";
	shareableAcrossSessions: boolean;
	liveActionsAllowed: boolean;
};

export type BrowserPilotRefPolicyDecision =
	| { ok: true; mode: "redacted" | "raw"; sameSession: boolean }
	| { ok: false; code: "REF_STALE" | "HANDLE_NOT_FOUND" | "HANDLE_EXPIRED" | "HANDLE_ETAG_MISMATCH" | "REF_SCOPE_VIOLATION" | "PRIVACY_BLOCKED"; reason: string; sameSession: boolean };

export type BrowserPilotRefAccessDescriptor = {
	kind: BrowserPilotRefKind;
	owner: {
		browserSessionId?: string;
		tabId?: number;
		topLevelOrigin?: string;
	};
	policy: BrowserPilotRefPolicy;
	snapshot?: unknown;
	createdAt: number;
	ttlMs: number;
};

export type BrowserPilotRefAccessContext = {
	browserSessionId?: string;
	tabId?: number;
	topLevelOrigin?: string;
	now: number;
	requestedRedaction: "default" | "disabled";
	explicitSensitiveAccess: boolean;
};

export function defaultRefPolicyForKind(kind: BrowserPilotRefKind, options: { hasOwnerBinding?: boolean; sensitive?: boolean } = {}): BrowserPilotRefPolicy {
	const hasOwnerBinding = options.hasOwnerBinding === true;
	const sensitive = options.sensitive === true;
	if (kind === "data-slice") {
		if (sensitive) {
			return { redaction: "disabled", shareableAcrossSessions: false, liveActionsAllowed: false };
		}
		return { redaction: "default", shareableAcrossSessions: !hasOwnerBinding, liveActionsAllowed: false };
	}
	if (kind === "element" || kind === "control" || kind === "frame" || kind === "region") {
		return { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true };
	}
	return { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false };
}

export function isRefExpired(ref: Pick<BrowserPilotRefAccessDescriptor, "createdAt" | "ttlMs">, now: number): boolean {
	return now > ref.createdAt + ref.ttlMs;
}

export function isSameSessionScope(ref: Pick<BrowserPilotRefAccessDescriptor, "owner">, context: Pick<BrowserPilotRefAccessContext, "browserSessionId" | "tabId">): boolean {
	const ownerSession = ref.owner.browserSessionId;
	const ownerTabId = ref.owner.tabId;
	if (ownerSession && ownerSession !== context.browserSessionId) return false;
	if (ownerTabId !== undefined && ownerTabId !== context.tabId) return false;
	return true;
}

export function classifyRefScope(ref: Pick<BrowserPilotRefAccessDescriptor, "kind" | "owner" | "policy">, context: Pick<BrowserPilotRefAccessContext, "browserSessionId" | "tabId" | "topLevelOrigin">): { ok: true; sameSession: boolean } | { ok: false; code: "REF_SCOPE_VIOLATION"; reason: string; sameSession: boolean } {
	const sameSession = isSameSessionScope(ref, context);
	if (ref.owner.browserSessionId && ref.owner.browserSessionId !== context.browserSessionId) {
		if (!(ref.kind === "data-slice" && ref.policy.shareableAcrossSessions)) return { ok: false, code: "REF_SCOPE_VIOLATION", reason: "browser session mismatch", sameSession };
	}
	if (ref.owner.tabId !== undefined && ref.owner.tabId !== context.tabId) {
		if (!(ref.kind === "data-slice" && ref.policy.shareableAcrossSessions)) return { ok: false, code: "REF_SCOPE_VIOLATION", reason: "tab mismatch", sameSession };
	}
	if (ref.owner.topLevelOrigin && context.topLevelOrigin && ref.owner.topLevelOrigin !== context.topLevelOrigin && !(ref.kind === "data-slice" && ref.policy.shareableAcrossSessions)) {
		return { ok: false, code: "REF_SCOPE_VIOLATION", reason: "top-level origin mismatch", sameSession };
	}
	return { ok: true, sameSession };
}

export function decideRefAccess(
	ref: BrowserPilotRefAccessDescriptor,
	context: BrowserPilotRefAccessContext,
	options: { resourceFound?: boolean; resourceExpired?: boolean; etagMatches?: boolean; sensitive?: boolean } = {},
): BrowserPilotRefPolicyDecision {
	const sameSession = isSameSessionScope(ref, context);
	if (isRefExpired(ref, context.now)) return { ok: false, code: "REF_STALE", reason: "ref ttl expired", sameSession };
	if (options.resourceFound === false) return { ok: false, code: "HANDLE_NOT_FOUND", reason: "snapshot resource not found", sameSession };
	if (options.resourceExpired === true) return { ok: false, code: "HANDLE_EXPIRED", reason: "snapshot resource expired", sameSession };
	if (options.etagMatches === false) return { ok: false, code: "HANDLE_ETAG_MISMATCH", reason: "snapshot etag mismatch", sameSession };
	const scope = classifyRefScope(ref, context);
	if (!scope.ok) return scope;
	if (ref.policy.redaction === "default") {
		if (context.requestedRedaction === "default") return { ok: true, mode: "redacted", sameSession };
		if (options.sensitive === false && sameSession && context.explicitSensitiveAccess) return { ok: true, mode: "raw", sameSession };
		return { ok: false, code: "PRIVACY_BLOCKED", reason: "raw access requires explicit safe same-session opt-in", sameSession };
	}
	if (context.requestedRedaction === "default") return { ok: true, mode: "redacted", sameSession };
	if (!context.explicitSensitiveAccess) return { ok: false, code: "PRIVACY_BLOCKED", reason: "raw sensitive access requires explicit opt-in", sameSession };
	if (!sameSession) return { ok: false, code: "PRIVACY_BLOCKED", reason: "raw sensitive access is same-session only", sameSession };
	return { ok: true, mode: "raw", sameSession };
}
