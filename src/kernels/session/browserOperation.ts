export type BrowserOperationStatus =
	| "completed"
	| "effect_observed"
	| "no_effect"
	| "stalled"
	| "ambiguous"
	| "target_lost"
	| "failed"
	| "deadline";

export type BrowserOperationTarget = {
	browserSessionId?: string;
	targetRef?: string;
	tabId?: number;
	generation?: number;
	url?: string;
	scriptable?: boolean;
	cdpAvailable?: boolean;
};

export type BrowserOperationSignals = {
	navigation?: string;
	mutationCount?: number;
	networkStarted?: number;
	networkCompleted?: number;
	networkPending?: number;
	dialogs?: number;
	newTabs?: number;
	downloadsStarted?: number;
	downloadsCompleted?: number;
	targetChanged?: boolean;
};

export type BrowserOperationEvent = {
	operationId: string;
	sequence: number;
	type: string;
	timestamp: number;
	targetRef?: string;
	tabId?: number;
	generation?: number;
	progress?: boolean;
	late?: boolean;
	data?: Record<string, unknown>;
};

export type BrowserOperationLateEffect = {
	type: "late_effect";
	operationId: string;
	commandName: string;
	terminalStatus: BrowserOperationStatus;
	event: BrowserOperationEvent;
};

export type BrowserOperationOutcome = {
	version: "browser-operation/v1";
	operationId: string;
	commandName: string;
	status: BrowserOperationStatus;
	target: BrowserOperationTarget;
	dispatch: {
		acknowledged: boolean;
		started: boolean;
		finished: boolean;
		startedAt: number;
		finishedAt?: number;
	};
	signals: BrowserOperationSignals;
	completion?: {
		source: string;
		evidence: Record<string, unknown>;
	};
	pageEffect?: {
		appeared?: unknown[];
		disappeared?: unknown[];
		changed?: unknown[];
		newActionables?: unknown[];
	};
	diagnostics?: unknown[];
	lateEffects?: BrowserOperationLateEffect[];
};
