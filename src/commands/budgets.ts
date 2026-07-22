export const TOOL_RESULT_BUDGETS = {
	browser_tabs: 50_000,
	browser_command: 50_000,
	browser_execute: 50_000,
	browser_observe: 35_000,
	browser_screenshot: 20_000,
	browser_artifact: 8_000,
} as const;

export type ToolResultBudgetName = keyof typeof TOOL_RESULT_BUDGETS;

export function defaultResultBudget(name: ToolResultBudgetName): number {
	return TOOL_RESULT_BUDGETS[name];
}
