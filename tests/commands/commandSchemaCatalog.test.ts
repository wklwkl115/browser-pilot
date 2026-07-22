import assert from "node:assert/strict";
import test from "node:test";
import { browserCommandDefinitions } from "../../src/commands/commandDefinitions.ts";
import { validateBrowserCommandArguments } from "../../src/commands/commandValidation.ts";
import { selectDiffBaselineSnapshot, validateObserveArguments } from "../../src/commands/observeCommand.ts";
import { validateCommandArgs } from "../../src/validation/commandArgs.ts";
import { validateBridgeCommand } from "../../src/types/nativeProtocol.ts";

function command(name: string) {
	const definition = browserCommandDefinitions().find((item) => item.name === name);
	assert.ok(definition, `${name} should be registered`);
	return definition;
}

test("public schemas reject unknown tool inputs without enumerating native commands", () => {
	const execute = command("browser_execute");
	assert.deepEqual(execute.validateArguments?.({ script: "document.title", readOnly: true }), []);
	assert.deepEqual(execute.validateArguments?.({}), [{ code: "EXECUTE_SCRIPT_REQUIRED", path: "/script", message: "browser_execute requires script" }]);
	assert.equal(validateCommandArgs(execute.parameters, { script: "browserPilot.refs.target.click()", refs: { target: "bp-ref://control/1" } }).ok, true);
	assert.equal(validateCommandArgs(execute.parameters, { script: "return 1", refs: { "not-valid-name": "bp-ref://control/1" } }).ok, false);

	const invalid = validateCommandArgs(command("browser_command").parameters, { command: { cmd: "tabs" }, typo: true });
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.error, /unknown parameter "typo"/);
	assert.equal(validateCommandArgs(command("browser_command").parameters, { command: { cmd: "batch", commands: [] } }).ok, true);
});

test("input.ref public protocol requires an opaque ref instead of a private target", () => {
	assert.equal(validateBridgeCommand({ cmd: "input.ref", action: "click", ref: "bp-ref://control/1", target: {} }, { allowMissingTabId: true }).ok, true);
	assert.equal(validateBridgeCommand({ cmd: "input.ref", action: "click", target: {} }, { allowMissingTabId: true }).ok, false);
});

test("browser_observe rejects contradictory freshness inputs", () => {
	assert.deepEqual(validateObserveArguments({ fresh: true, diff: true }), [{ code: "OBSERVE_FRESH_DIFF_CONFLICT", path: "/fresh", message: "browser_observe fresh:true cannot be combined with diff:true" }]);
});

test("browser_tabs rejects removed session actions at the public validation boundary", () => {
	const validation = validateBrowserCommandArguments(command("browser_tabs"), { action: "selectSession", browserSessionId: "session-1" });
	assert.equal(validation.ok, false);
	if (!validation.ok) assert.match(validation.error, /browserSessionId.*removed/);
});

function pageIdentity(browserSessionId: string, tabId: number, pageEpoch = "page-1") {
	return { browserSessionId, tabId, targetGeneration: 1, pageEpoch, url: "https://example.test/" };
}

function baselineServer(snapshots: Array<Record<string, unknown>>) {
	return {
		snapshot: () => ({ browserSessionId: "session-1", defaultTabId: 7, tabs: [{ tabId: 7, generation: 1, targetGeneration: 1, pageEpoch: "page-1", url: "https://example.test/" }] }),
		resolveTargetTabId: (value: unknown) => typeof value === "number" ? value : undefined,
		listObservationSnapshots: () => snapshots,
	};
}

test("diff baseline uses the newest valid snapshot from the current page", () => {
	const snapshots = [
		{ snapshotId: "wrong-session", browserSessionId: "session-2", tabId: 7, pageIdentity: pageIdentity("session-2", 7), sourceMode: "scan", capturedAt: 50, ttlMs: 1_000, saved: { path: "wrong.json" } },
		{ snapshotId: "wrong-page", browserSessionId: "session-1", tabId: 7, pageIdentity: pageIdentity("session-1", 7, "page-old"), sourceMode: "scan", capturedAt: 40, ttlMs: 1_000, saved: { path: "old.json" } },
		{ snapshotId: "expired", browserSessionId: "session-1", tabId: 7, pageIdentity: pageIdentity("session-1", 7), sourceMode: "scan", capturedAt: 30, ttlMs: 1_000, expired: true, saved: { path: "expired.json" } },
		{ snapshotId: "no-file", browserSessionId: "session-1", tabId: 7, pageIdentity: pageIdentity("session-1", 7), sourceMode: "scan", capturedAt: 25, ttlMs: 1_000 },
		{ snapshotId: "older", browserSessionId: "session-1", tabId: 7, pageIdentity: pageIdentity("session-1", 7), sourceMode: "scan", capturedAt: 10, ttlMs: 1_000, saved: { path: "older.json" } },
		{ snapshotId: "newest", browserSessionId: "session-1", tabId: 7, pageIdentity: pageIdentity("session-1", 7), sourceMode: "scan", capturedAt: 20, ttlMs: 1_000, saved: { path: "newest.json" } },
	];
	assert.equal(selectDiffBaselineSnapshot(baselineServer(snapshots) as never, { browserSessionId: "session-1", diff: true }), "newest");
	assert.equal(selectDiffBaselineSnapshot(baselineServer(snapshots.slice(0, 2)) as never, { browserSessionId: "session-1", diff: true }), undefined);
});
