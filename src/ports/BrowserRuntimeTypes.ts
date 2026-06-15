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
	browserId?: string;
	openerTabId?: number;
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
