import type { BrowserBridgeTargetInfo } from "../ports/BrowserRuntimeTypes.js";
import type { CommandTemporalConfidence, CommandTemporalFrontierNext, CommandTemporalReason, CommandTemporalVerdictStatus } from "../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../utils/params.js";
import { pickDefined } from "../utils/records.js";

export type ExecuteEffect = {
	url?: string;
	signals?: "partial";
	coverage?: "overflow";
	mutations?: number;
	settled?: boolean;
	navigated: boolean;
	visibleDelta?: number;
	interactiveDelta?: number;
	dirty?: {
		roots: string[];
		overflow: boolean;
		sinceSeq?: number;
	};
	requestsFired?: number;
	hookEventsFired?: number;
	targetDelta?: {
		selectionVersionBefore?: number;
		selectionVersionAfter?: number;
		tabIdBefore?: number;
		tabIdAfter?: number;
	};
	anchor?: {
		changeSeq?: number;
		networkSeq?: number;
		hookSeq?: number;
	};
	targetObservedAt?: number;
	targetObservationId?: string;
	targetRef?: string;
	targetRegionDirty?: boolean;
	targetDirtyRoots?: string[];
	temporal?: {
		verdict: {
			status: CommandTemporalVerdictStatus;
			confidence: CommandTemporalConfidence;
			reasons: CommandTemporalReason[];
		};
		frontier: {
			next: CommandTemporalFrontierNext;
			handle?: string;
		};
	};
};

export type ExecutionJournal = {
	version: 1;
	operationId?: string;
	target?: {
		tabId?: number;
		browserSessionId?: string;
		selectionVersionAtDispatch?: number;
		selectionVersionAtResolve?: number;
	};
	dispatch?: {
		kind: "javascript" | "native-command" | "input" | "program";
		command?: string;
		cdpSessionName?: string;
		eventCount?: number;
		text?: { redacted: true; charCount: number };
	};
	effect?: ExecuteEffect;
	monitor?: Record<string, unknown>;
	stdlib?: {
		used: boolean;
		refsEmbedded?: number;
		resolveMisses?: number;
	};
};

export function compactExecutionEffect(effect: ExecuteEffect | undefined): Record<string, unknown> | undefined {
	if (!effect) return undefined;
	const compact = pickDefined(effect as unknown as Record<string, unknown>, ["signals", "coverage", "mutations", "settled", "navigated", "visibleDelta", "interactiveDelta", "dirty", "requestsFired", "hookEventsFired", "targetDelta", "anchor", "targetObservedAt", "targetObservationId", "targetRef", "targetRegionDirty", "targetDirtyRoots", "temporal"]);
	if (!effect.navigated) delete compact.navigated;
	if (!effect.dirty?.roots.length && effect.dirty?.overflow !== true) delete compact.dirty;
	if (!effect.targetDelta || Object.keys(effect.targetDelta).length === 0) delete compact.targetDelta;
	if (!effect.targetObservationId) delete compact.targetObservationId;
	if (!effect.targetRef) delete compact.targetRef;
	if (effect.targetRegionDirty !== true) delete compact.targetRegionDirty;
	if (!effect.targetDirtyRoots?.length) delete compact.targetDirtyRoots;
	return compact;
}

export function targetForExecutionJournal(target: BrowserBridgeTargetInfo | undefined): ExecutionJournal["target"] | undefined {
	if (!target) return undefined;
	return {
		...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
		...(target.browserSessionId ? { browserSessionId: target.browserSessionId } : {}),
		...(target.selectionVersionAtDispatch !== undefined ? { selectionVersionAtDispatch: target.selectionVersionAtDispatch } : {}),
		...(target.selectionVersionAtResolve !== undefined ? { selectionVersionAtResolve: target.selectionVersionAtResolve } : {}),
	};
}

export function buildExecutionJournal(input: {
	operationId?: string;
	target?: BrowserBridgeTargetInfo;
	dispatch?: ExecutionJournal["dispatch"];
	effect?: ExecuteEffect;
	monitor?: unknown;
	stdlib?: ExecutionJournal["stdlib"];
}): ExecutionJournal {
	return {
		version: 1,
		...(input.operationId ? { operationId: input.operationId } : {}),
		...(input.target ? { target: targetForExecutionJournal(input.target) } : {}),
		...(input.dispatch ? { dispatch: input.dispatch } : {}),
		...(input.effect ? { effect: input.effect } : {}),
		...(isRecord(input.monitor) ? { monitor: input.monitor } : {}),
		...(input.stdlib ? { stdlib: input.stdlib } : {}),
	};
}
