import type { BrowserPilotRefKind } from "./core.js";

export type BrowserPilotRefPolicy = {
	shareableAcrossSessions: boolean;
	liveActionsAllowed: boolean;
};

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
};

export function defaultRefPolicyForKind(
	kind: BrowserPilotRefKind,
	options: { hasOwnerBinding?: boolean } = {},
): BrowserPilotRefPolicy {
	const hasOwnerBinding = options.hasOwnerBinding === true;
	if (kind === "data-slice") return { shareableAcrossSessions: !hasOwnerBinding, liveActionsAllowed: false };
	if (kind === "element" || kind === "control" || kind === "frame" || kind === "region")
		return { shareableAcrossSessions: false, liveActionsAllowed: true };
	return { shareableAcrossSessions: false, liveActionsAllowed: false };
}

export function isRefExpired(ref: Pick<BrowserPilotRefAccessDescriptor, "createdAt" | "ttlMs">, now: number): boolean {
	return now > ref.createdAt + ref.ttlMs;
}

export function isSameSessionScope(
	ref: Pick<BrowserPilotRefAccessDescriptor, "owner">,
	context: Pick<BrowserPilotRefAccessContext, "browserSessionId" | "tabId">,
): boolean {
	const ownerSession = ref.owner.browserSessionId;
	const ownerTabId = ref.owner.tabId;
	if (ownerSession && ownerSession !== context.browserSessionId) return false;
	if (ownerTabId !== undefined && ownerTabId !== context.tabId) return false;
	return true;
}

export function classifyRefScope(
	ref: Pick<BrowserPilotRefAccessDescriptor, "kind" | "owner" | "policy">,
	context: Pick<BrowserPilotRefAccessContext, "browserSessionId" | "tabId" | "topLevelOrigin">,
):
	| { ok: true; sameSession: boolean }
	| { ok: false; code: "REF_SCOPE_VIOLATION"; reason: string; sameSession: boolean } {
	const sameSession = isSameSessionScope(ref, context);
	const shareable = ref.kind === "data-slice" && ref.policy.shareableAcrossSessions;
	if (ref.owner.browserSessionId && ref.owner.browserSessionId !== context.browserSessionId && !shareable)
		return { ok: false, code: "REF_SCOPE_VIOLATION", reason: "browser session mismatch", sameSession };
	if (ref.owner.tabId !== undefined && ref.owner.tabId !== context.tabId && !shareable)
		return { ok: false, code: "REF_SCOPE_VIOLATION", reason: "tab mismatch", sameSession };
	if (
		ref.owner.topLevelOrigin &&
		context.topLevelOrigin &&
		ref.owner.topLevelOrigin !== context.topLevelOrigin &&
		!shareable
	)
		return { ok: false, code: "REF_SCOPE_VIOLATION", reason: "top-level origin mismatch", sameSession };
	return { ok: true, sameSession };
}
