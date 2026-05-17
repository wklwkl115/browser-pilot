export const TOOL_RESULT_BUDGETS = {
	browser_execute: 50_000,
	browser_scan: 35_000,
	browser_pick: 12_000,
	browser_content: 20_000,
	browser_query: 12_000,
	browser_click: 12_000,
	browser_type: 12_000,
	browser_dom_snapshot: 16_000,
	browser_dom_click: 12_000,
	browser_dom_type: 12_000,
	browser_upload: 12_000,
	browser_download: 12_000,
	browser_wait: 50_000,
	browser_network: 12_000,
	browser_hook: 50_000,
	browser_frame: 50_000,
	browser_evidence: 12_000,
	browser_html: 20_000,
	browser_screenshot: 20_000,
	browser_artifact: 8_000,
} as const;

export type ToolResultBudgetName = keyof typeof TOOL_RESULT_BUDGETS;

export function defaultResultBudget(name: ToolResultBudgetName): number {
	return TOOL_RESULT_BUDGETS[name];
}
