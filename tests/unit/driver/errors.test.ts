import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeError, errorToPlain, noBrowserExtensionError, tabNotFoundError } from "../../../src/driver/errors.ts";
import { compactError } from "../../../src/utils/errors.ts";

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

test("errorToPlain and BrowserBridgeError JSON redact details and recovery actions", () => {
	const err = new BrowserBridgeError("INVALID_RULE", "bad token=driver-secret", {
		query: "token=driver-secret",
		recovery: { nextActions: ["retry with token=driver-secret"] },
	});
	const plain = errorToPlain(err);
	const plainText = JSON.stringify(plain);
	assert.equal(plainText.includes("driver-secret"), false);
	assert.equal(plainText.includes("token=[redacted]"), true);
	const jsonText = JSON.stringify(err);
	assert.equal(jsonText.includes("driver-secret"), false);
	assert.equal(jsonText.includes("token=[redacted]"), true);
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

test("noBrowserExtensionError carries actionable recovery for a cold start", () => {
	const err = noBrowserExtensionError({ port: 18765, everConnected: false });
	assert.equal(err.code, "NO_BROWSER_EXTENSION");
	assert.equal(err.details.everConnected, false);
	const recovery = err.details.recovery as Record<string, unknown>;
	assert.equal(recovery.retryable, true);
	assert.ok(Array.isArray(recovery.nextActions) && (recovery.nextActions as unknown[]).length >= 2);
	assert.match(String(recovery.hint), /loaded and enabled/i, "cold start tells the caller to load/enable the extension");
	assert.equal(err.details.port, 18765, "the port stays structured in details, not embedded in volatile prose");
});

test("noBrowserExtensionError distinguishes a dropped service worker from a cold start", () => {
	const err = noBrowserExtensionError({ port: 18765, everConnected: true });
	assert.equal(err.details.everConnected, true);
	assert.match(String((err.details.recovery as Record<string, unknown>).hint), /service worker likely went idle/i);
});

test("noBrowserExtensionError recovery survives normalization so the agent sees nextActions", () => {
	// The original gap: the bare throw produced no recovery. compactError must now
	// lift the recovery actions (and the diagnostics mirror) onto the rendered error.
	const compact = compactError(noBrowserExtensionError({ port: 18765, everConnected: false }));
	const recovery = compact.recovery as Record<string, unknown> | undefined;
	assert.ok(recovery && Array.isArray(recovery.nextActions) && (recovery.nextActions as unknown[]).length >= 2);
	assert.match(JSON.stringify(compact), /open or reload any browser tab/i);
});
