export type BrowserRuntimeCommand = {
	cmd: string;
	method?: string;
	tabId?: number | string;
	[key: string]: unknown;
};

export type BrowserBridgeTargetSource = "explicit" | "default" | "latest" | "none";

export type BrowserBridgeTargetInfo = {
	browserSessionId?: string;
	tabId?: number;
	tabHandle?: string;
	targetRef?: string;
	requestedTabId?: number;
	replacedFrom?: number;
	replacedByTabId?: number;
	replacementHops?: number;
	/** How many more replacement hops are available before hitting the chain depth limit. */
	replacementHopsRemaining?: number;
	/** Milliseconds since the first replacement in the chain was recorded. */
	replacementChainAge?: number;
	browserId?: string;
	openerTabId?: number;
	generation?: number;
	pageEpoch?: string;
	documentId?: string;
	url?: string;
	source: BrowserBridgeTargetSource;
	implicit: boolean;
	selectionVersionAtDispatch: number;
	selectionVersionAtResolve?: number;
};

export type BrowserBridgeExecutionResult<TData = unknown, TNewTabs = unknown[]> = {
	id: string;
	acknowledged: boolean;
	tabId?: number;
	data?: TData;
	newTabs?: TNewTabs;
	target?: BrowserBridgeTargetInfo;
	createdTarget?: BrowserBridgeTargetInfo;
	createdTab?: Record<string, unknown>;
	diagnostics?: Record<string, unknown>;
};
