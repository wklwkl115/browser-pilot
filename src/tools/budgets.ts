export const TOOL_RESULT_BUDGETS = {
	browser_command: 50_000,
	browser_execute: 50_000,
	browser_observe: 35_000,
	browser_pick: 12_000,
	browser_upload: 12_000,
	browser_download: 12_000,
	browser_wait: 50_000,
	browser_network: 12_000,
	browser_hook: 50_000,
	browser_frame: 50_000,
	browser_evidence: 12_000,
	browser_screenshot: 20_000,
	browser_artifact: 8_000,
	browser_recon_probe: 12_000,
	browser_crawl: 12_000,
	browser_fuzz_paths: 12_000,
	browser_fuzz_vhosts: 12_000,
	browser_sqli_probe: 12_000,
	browser_sqlmap_bridge: 12_000,
	browser_nuclei_bridge: 12_000,
	browser_template_check: 12_000,
	browser_callback_oast: 12_000,
	browser_cookie_analyze: 12_000,
	browser_fuzz_params: 12_000,
	browser_http_replay: 12_000,
} as const;

export type ToolResultBudgetName = keyof typeof TOOL_RESULT_BUDGETS;

export function defaultResultBudget(name: ToolResultBudgetName): number {
	return TOOL_RESULT_BUDGETS[name];
}
