import type { BrowserBridgeTargetInfo } from "../driver/types.js";
import { isRecord } from "../utils/params.js";

export type ExecuteEffect = {
	url?: string;
	signals?: "partial";
	mutations?: number;
	settled?: boolean;
	navigated: boolean;
	visibleDelta?: number;
	interactiveDelta?: number;
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
		kind: "javascript" | "native-command" | "input";
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
	return {
		...(effect.signals ? { signals: effect.signals } : {}),
		...(effect.mutations !== undefined ? { mutations: effect.mutations } : {}),
		...(effect.settled !== undefined ? { settled: effect.settled } : {}),
		...(effect.navigated ? { navigated: true } : {}),
		...(effect.visibleDelta !== undefined ? { visibleDelta: effect.visibleDelta } : {}),
		...(effect.interactiveDelta !== undefined ? { interactiveDelta: effect.interactiveDelta } : {}),
		...(effect.requestsFired !== undefined ? { requestsFired: effect.requestsFired } : {}),
		...(effect.hookEventsFired !== undefined ? { hookEventsFired: effect.hookEventsFired } : {}),
		...(effect.targetDelta && Object.keys(effect.targetDelta).length ? { targetDelta: effect.targetDelta } : {}),
		...(effect.anchor ? { anchor: effect.anchor } : {}),
	};
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

export function executionJournalFromValue(value: unknown): ExecutionJournal | undefined {
	const record = isRecord(value) ? value : undefined;
	return isRecord(record?.execution) ? record.execution as ExecutionJournal : undefined;
}
