export type PageIdentity = {
	browserSessionId: string;
	tabId: number;
	targetGeneration: number;
	pageEpoch: string;
	documentId?: string;
	url: string;
};

export type PageReanchorReason =
	| "document_changed"
	| "target_replaced"
	| "session_changed"
	| "identity_unproven"
	| "baseline_missing";

function validIdentity(identity: PageIdentity | undefined): identity is PageIdentity {
	return !!identity
		&& identity.browserSessionId.length > 0
		&& Number.isInteger(identity.tabId)
		&& identity.tabId > 0
		&& Number.isInteger(identity.targetGeneration)
		&& identity.targetGeneration > 0
		&& identity.pageEpoch.length > 0;
}

/** URL and documentId are facts; equality is defined only by the stable identity tuple. */
export function samePageIdentity(a: PageIdentity | undefined, b: PageIdentity | undefined): boolean {
	return validIdentity(a)
		&& validIdentity(b)
		&& a.browserSessionId === b.browserSessionId
		&& a.tabId === b.tabId
		&& a.targetGeneration === b.targetGeneration
		&& a.pageEpoch === b.pageEpoch;
}

export function pageReanchorReason(
	baseline: PageIdentity | undefined,
	current: PageIdentity | undefined,
): PageReanchorReason | undefined {
	if (!baseline) return "baseline_missing";
	if (!validIdentity(baseline) || !validIdentity(current)) return "identity_unproven";
	if (baseline.browserSessionId !== current.browserSessionId) return "session_changed";
	if (baseline.tabId !== current.tabId || baseline.targetGeneration !== current.targetGeneration) return "target_replaced";
	if (baseline.pageEpoch !== current.pageEpoch) return "document_changed";
	return undefined;
}
