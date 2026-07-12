import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { pageReanchorReason } from "../../kernels/session/pageIdentity.js";
import type { BrowserCommandRuntimePort, BrowserCommandRuntimeSnapshot, CommandPerceptionLedgerKey } from "../../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../../utils/records.js";

type IdentitySignal = {
	pageEpoch?: string;
	documentId?: string;
	url?: string;
};

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function fallbackString(primary: unknown, fallback: unknown): string | undefined {
	return nonEmptyString(primary ?? fallback);
}

function matchingIdentityTab(bridge: BrowserCommandRuntimeSnapshot, tabId: number | undefined): Record<string, unknown> | undefined {
	return (bridge.tabs ?? []).find((item) => positiveInteger(item.tabId ?? item.id) === tabId);
}

function tabTargetGeneration(tab: Record<string, unknown> | undefined): number | undefined {
	if (!tab) return undefined;
	return positiveInteger(tab.targetGeneration) ?? positiveInteger(tab.generation);
}

function pageEpochSignalMatchesTab(signal: IdentitySignal | undefined, tab: Record<string, unknown> | undefined): boolean {
	const signalEpoch = nonEmptyString(signal?.pageEpoch);
	const tabEpoch = nonEmptyString(tab?.pageEpoch);
	return !signalEpoch || !tabEpoch || signalEpoch === tabEpoch;
}

export function currentPageIdentity(
	server: BrowserCommandRuntimePort,
	options: { browserSessionId?: string; tabId?: number },
	signal?: IdentitySignal,
): PageIdentity | undefined {
	const bridge = server.snapshot({ browserSessionId: options.browserSessionId });
	const tabId = options.tabId ?? bridge.defaultTabId;
	const tab = matchingIdentityTab(bridge, tabId);
	const browserSessionId = fallbackString(bridge.browserSessionId, options.browserSessionId);
	const targetGeneration = tabTargetGeneration(tab);
	if (!pageEpochSignalMatchesTab(signal, tab)) return undefined;
	const pageEpoch = fallbackString(signal?.pageEpoch, tab?.pageEpoch);
	if (!browserSessionId || !tabId || !targetGeneration || !pageEpoch) return undefined;
	const documentId = fallbackString(signal?.documentId, tab?.documentId);
	return {
		browserSessionId,
		tabId,
		targetGeneration,
		pageEpoch,
		...(documentId ? { documentId } : {}),
		url: fallbackString(signal?.url, tab?.url) ?? "",
	};
}

export function pageIdentityFromUnknown(value: unknown): PageIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const direct = isRecord(value.pageIdentity) ? value.pageIdentity : value;
	const browserSessionId = nonEmptyString(direct.browserSessionId);
	const tabId = positiveInteger(direct.tabId);
	const targetGeneration = positiveInteger(direct.targetGeneration ?? direct.generation);
	const pageEpoch = nonEmptyString(direct.pageEpoch);
	if (browserSessionId && tabId && targetGeneration && pageEpoch) {
		return {
			browserSessionId,
			tabId,
			targetGeneration,
			pageEpoch,
			...(nonEmptyString(direct.documentId) ? { documentId: nonEmptyString(direct.documentId) } : {}),
			url: nonEmptyString(direct.url) ?? "",
		};
	}
	for (const key of ["snapshot", "pageObservation", "summary", "envelope", "data"] as const) {
		const nested = pageIdentityFromUnknown(value[key]);
		if (nested) return nested;
	}
	return undefined;
}

export function perceptionLedgerKey(identity: PageIdentity | undefined): CommandPerceptionLedgerKey | undefined {
	return identity ? {
		browserSessionId: identity.browserSessionId,
		tabId: identity.tabId,
		targetGeneration: identity.targetGeneration,
		pageEpoch: identity.pageEpoch,
	} : undefined;
}

export function baselineReanchorReason(
	baseline: PageIdentity | undefined,
	current: PageIdentity | undefined,
): PageReanchorReason | undefined {
	return pageReanchorReason(baseline, current);
}
