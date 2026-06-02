import test from "node:test";
import assert from "node:assert/strict";
import { tabNotFoundError } from "../../../src/driver/errors.ts";

test("tabNotFoundError suggests the live/current tab and omitting tabId", () => {
	const err = tabNotFoundError({ tabId: 999, tabs: [{ tabId: 12 }, { tabId: 34 }], latestTabId: 34 });
	assert.equal(err.code, "TAB_NOT_FOUND");
	const recovery = err.details.recovery as Record<string, unknown>;
	assert.equal(recovery.retryable, true);
	assert.equal(recovery.suggestedTabId, 34);
	assert.deepEqual(recovery.liveTabIds, [12, 34]);
	assert.match(String(recovery.hint), /omit tabId/i);
	assert.match(String(recovery.hint), /34/);
});

test("tabNotFoundError handles the no-live-tabs case", () => {
	const err = tabNotFoundError({ tabId: 5, tabs: [] });
	const recovery = err.details.recovery as Record<string, unknown>;
	assert.deepEqual(recovery.liveTabIds, []);
	assert.equal("suggestedTabId" in recovery, false);
	assert.match(String(recovery.hint), /No browser tabs/i);
});
