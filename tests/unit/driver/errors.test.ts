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

test("tabNotFoundError keeps live tab diagnostics compact and strips URL query/hash", () => {
	const err = tabNotFoundError({
		tabId: 999,
		tabs: [{ tabId: 12, url: "https://login.example.test/oauth/callback?state=STATESECRET&code=CODESECRET#frag", title: "Login", active: true, extra: "drop" }],
		latestTabId: 12,
	});
	const tabs = err.details.tabs as Array<Record<string, unknown>>;
	assert.deepEqual(tabs, [{ tabId: 12, url: "https://login.example.test/oauth/callback?[redacted]", title: "Login", active: true }]);
	const text = JSON.stringify(err);
	assert.equal(text.includes("STATESECRET"), false);
	assert.equal(text.includes("CODESECRET"), false);
	assert.equal(text.includes("#frag"), false);
	assert.equal(text.includes("extra"), false);
});

test("tabNotFoundError keeps non-http URL diagnostics usable without query/hash", () => {
	const err = tabNotFoundError({
		tabId: 999,
		tabs: [
			{ tabId: 1, url: "about:blank" },
			{ tabId: 2, url: "chrome://newtab/" },
			{ tabId: 3, url: "file:///C:/tmp/report.html?token=FILESECRET#frag" },
		],
	});
	const tabs = err.details.tabs as Array<Record<string, unknown>>;
	assert.deepEqual(tabs.map((tab) => tab.url), ["about:blank", "chrome://newtab/", "file:///C:/tmp/report.html?[redacted]"]);
	const text = JSON.stringify(err);
	assert.equal(text.includes("nullblank"), false);
	assert.equal(text.includes("FILESECRET"), false);
	assert.equal(text.includes("#frag"), false);
});

test("tabNotFoundError redacts inline payload URL schemes", () => {
	const err = tabNotFoundError({
		tabId: 999,
		tabs: [
			{ tabId: 1, url: "data:text/plain,DATASECRET" },
			{ tabId: 2, url: "javascript:alert('JSSECRET')" },
			{ tabId: 3, url: "mailto:user@example.test?subject=MAILSECRET" },
		],
	});
	const tabs = err.details.tabs as Array<Record<string, unknown>>;
	assert.deepEqual(tabs.map((tab) => tab.url), ["data:[redacted]", "javascript:[redacted]", "mailto:[redacted]"]);
	const text = JSON.stringify(err);
	assert.equal(text.includes("DATASECRET"), false);
	assert.equal(text.includes("JSSECRET"), false);
	assert.equal(text.includes("MAILSECRET"), false);
});

test("tabNotFoundError handles the no-live-tabs case", () => {
	const err = tabNotFoundError({ tabId: 5, tabs: [] });
	const recovery = err.details.recovery as Record<string, unknown>;
	assert.deepEqual(recovery.liveTabIds, []);
	assert.equal("suggestedTabId" in recovery, false);
	assert.match(String(recovery.hint), /No browser tabs/i);
});
