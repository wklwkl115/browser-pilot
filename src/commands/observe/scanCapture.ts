import { executeBrowserWaitWithSupervisor } from "../../browser-command-runtime/waitSupervisor.js";
import { createBrowserAbmlIntegration } from "../../browser-command-runtime/abml/integration.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { assertBridgeCommandSucceeded } from "../../utils/bridgeResultValidation.js";
import { normalizePageFingerprint, type PageFingerprint } from "../pageSignals.js";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import { scanCommandName } from "./renderCache.js";
import { withTrackedOperation, type CommandOnUpdate, type TrackedOperationHandle } from "../commandRuntime.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveMode, ObserveToolParams } from "./common.js";
import { isRecord } from "../../utils/params.js";

function scanResultFingerprint(value: unknown): PageFingerprint | undefined {
	const record = isRecord(value) ? value : {};
	const signals = isRecord(record.signals) ? record.signals : {};
	return normalizePageFingerprint(signals.fingerprint);
}

type ScanCaptureOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	mode: Extract<ObserveMode, "scan" | "text">;
	hasNavigation: boolean;
	rawTargetRef: unknown;
	browserSessionId: string | undefined;
	tabId: number | undefined;
	timeoutMs: number;
	captureMaxChars: number;
	scanScript: string;
	baseline: BaselineResolution | undefined;
	pageFingerprint: PageFingerprint | undefined;
	timings: ObserveTimingMetrics;
	onUpdate?: CommandOnUpdate;
};

async function navigateForScan(options: ScanCaptureOptions, handle: TrackedOperationHandle) {
	const { server, params, rawTargetRef, timeoutMs, timings } = options;
	if (!options.hasNavigation) return undefined;
	await handle.update({ progress: 20, phase: "navigating" });
	const startedAt = Date.now();
	const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url!, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: rawTargetRef as number | string | undefined, timeoutMs });
	timings.navigationMs = elapsedMs(startedAt);
	addBridgeRoundTrips(timings, 1);
	assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
	return navigation.data;
}

export async function executeScanCapture(options: ScanCaptureOptions) {
	const { server, params, mode, hasNavigation, rawTargetRef, browserSessionId, tabId, timeoutMs, captureMaxChars, scanScript, baseline, pageFingerprint, timings, onUpdate } = options;
	const abml = createBrowserAbmlIntegration(server, { browserSessionId, tabId, timeoutMs, maxChars: captureMaxChars });
	let fusedPageFingerprint: PageFingerprint | undefined;
	const { result: observation, operation } = await withTrackedOperation(server, {
		commandName: "browser_observe",
		command: scanCommandName(mode, hasNavigation),
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "scan",
	}, onUpdate, async (handle) => {
		const navigationData = await navigateForScan(options, handle);
		await handle.update({ progress: hasNavigation ? 50 : 40 });
		const pageScriptStartedAt = Date.now();
		const result = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: rawTargetRef, timeoutMs, name: "scan_extract" });
		timings.pageScriptMs = elapsedMs(pageScriptStartedAt);
		addBridgeRoundTrips(timings, 1);
		fusedPageFingerprint = scanResultFingerprint(result.data);
		if (fusedPageFingerprint) timings.fusedFingerprint = true;
		await handle.update({ progress: 70, details: { acknowledged: result.acknowledged, target: result.target } });
		const canReuseScanForAbml = mode !== "text" && params.includeIframes !== false && params.maxNodes === undefined && isRecord(result.data);
		timings.abmlPrefetchedScan = canReuseScanForAbml;
		const abmlStartedAt = Date.now();
		const abmlRead = await abml.readStructure({
			browserSessionId,
			tabId,
			timeoutMs,
			maxChars: captureMaxChars,
			baseline: baseline?.entities,
			diffOptions: baseline?.partialBaseline ? { partialBaseline: true } : undefined,
			prefetchedScan: canReuseScanForAbml ? result.data as Record<string, unknown> : undefined,
			axCacheKey: (pageFingerprint ?? fusedPageFingerprint) ? `content:${(pageFingerprint ?? fusedPageFingerprint)!.changeSeq}:${(pageFingerprint ?? fusedPageFingerprint)!.url || ""}` : undefined,
		});
		timings.abmlMs = elapsedMs(abmlStartedAt);
		if (!canReuseScanForAbml) addBridgeRoundTrips(timings, 1);
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target, abml: abmlRead?.ok === true ? { entityCount: abmlRead.entities?.length ?? 0 } : { ok: false } } });
		return { result, abmlRead, navigationData };
	});
	return { observation, operation, fusedPageFingerprint };
}
