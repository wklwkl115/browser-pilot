import test from "node:test";
import assert from "node:assert/strict";
import { defaultResultBudget, TOOL_RESULT_BUDGETS } from "../../../src/tools/budgets.ts";

test("defaultResultBudget returns correct budget for browser_command", () => {
	assert.equal(defaultResultBudget("browser_command"), 50_000);
});

test("defaultResultBudget returns correct budget for browser_observe", () => {
	assert.equal(defaultResultBudget("browser_observe"), 35_000);
});

test("defaultResultBudget returns correct budget for browser_artifact", () => {
	assert.equal(defaultResultBudget("browser_artifact"), 8_000);
});

test("TOOL_RESULT_BUDGETS contains all core browser tools", () => {
	const required = [
		"browser_command", "browser_execute", "browser_observe", "browser_pick",
		"browser_upload", "browser_download", "browser_wait", "browser_network",
		"browser_hook", "browser_frame", "browser_evidence", "browser_screenshot",
		"browser_artifact", "browser_memory",
	];
	for (const tool of required) {
		assert.ok(tool in TOOL_RESULT_BUDGETS, `${tool} should be in TOOL_RESULT_BUDGETS`);
	}
});

test("TOOL_RESULT_BUDGETS contains web security tools", () => {
	const required = ["browser_crawl", "browser_fuzz", "browser_sqli", "browser_http_replay", "browser_cookie_analyze"];
	for (const tool of required) {
		assert.ok(tool in TOOL_RESULT_BUDGETS, `${tool} should be in TOOL_RESULT_BUDGETS`);
	}
});

test("all TOOL_RESULT_BUDGETS values are positive integers", () => {
	for (const [tool, budget] of Object.entries(TOOL_RESULT_BUDGETS)) {
		assert.ok(typeof budget === "number" && budget > 0 && Number.isInteger(budget), `budget for ${tool} should be positive integer, got ${budget}`);
	}
});
