import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { resolveLocalTargetTabId, targetTabId } from "../commandRuntime.js";
import type { PageIdentity } from "../../kernels/session/pageIdentity.js";
import { currentPageIdentity } from "./pageIdentity.js";

export type ObserveToolParams = {
	browserSessionId?: string;
	targetRef?: string;
	/** Internal server-selected snapshot; never part of the public tool schema. */
	baseline?: string;
	fresh?: boolean;
	diff?: boolean;
	visual?: "auto" | "always" | "never";
};

export function currentObserveSnapshotMeta(server: BrowserCommandRuntimePort, params: ObserveToolParams, savedPath: string | undefined, url: string | undefined, networkSeq?: number, hookSeq?: number, identityOverride?: PageIdentity) {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const rawTargetRef = targetTabId(params);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, params.browserSessionId) ?? bridge.defaultTabId;
	const pageIdentity = identityOverride ?? currentPageIdentity(server, { browserSessionId: params.browserSessionId, tabId });
	return server.createObservationSnapshot({
		browserSessionId: bridge.browserSessionId,
		tabId,
		url,
		...(pageIdentity ? {
			targetGeneration: pageIdentity.targetGeneration,
			pageEpoch: pageIdentity.pageEpoch,
			...(pageIdentity.documentId ? { documentId: pageIdentity.documentId } : {}),
		} : {}),
		frameScope: "tab",
		selectionVersion: bridge.selectionVersion,
		sourceMode: "scan",
		capturedAt: Date.now(),
		networkSeq,
		hookSeq,
		saved: savedPath ? { path: savedPath } : undefined,
	});
}
