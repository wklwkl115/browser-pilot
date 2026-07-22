import assert from "node:assert/strict";
import test from "node:test";
import { browserCommandDefinitions } from "../../src/commands/commandDefinitions.ts";
import { validateBrowserCommandArguments } from "../../src/commands/commandValidation.ts";
import { selectDiffBaselineSnapshot, validateObserveArguments } from "../../src/commands/observeCommand.ts";
import { validateCommandArgs } from "../../src/validation/commandArgs.ts";
import { getNativeCommandProtocolSchema, validateBridgeCommand } from "../../src/types/nativeProtocol.ts";
import { publicNativeCommandNames } from "../../src/commands/nativeCommandAccess.ts";

function command(name: string) {
	const definition = browserCommandDefinitions().find((item) => item.name === name);
	assert.ok(definition, `${name} should be registered`);
	return definition;
}

function deepKeys(value: unknown): string[] {
	return value && typeof value === "object"
		? Object.entries(value).flatMap(([key, nested]) => [key, ...deepKeys(nested)])
		: [];
}

test("public tool surface remains five general tools without new mechanical inputs", () => {
	const definitions = browserCommandDefinitions();
	assert.deepEqual(definitions.map((definition) => definition.name), ["browser_tabs", "browser_command", "browser_execute", "browser_observe", "browser_screenshot"]);
	assert.deepEqual(Object.keys((command("browser_execute").parameters as { properties: Record<string, unknown> }).properties), ["script", "refs", "readOnly", "targetRef"]);
	assert.deepEqual(Object.keys((command("browser_command").parameters as { properties: Record<string, unknown> }).properties), ["command", "targetRef"]);
	const forbiddenFields = new Set(["browserSessionId", "tabId", "sessionId", "timeoutMs", "targetId"]);
	for (const definition of definitions) {
		assert.deepEqual(deepKeys(definition.parameters).filter((field) => forbiddenFields.has(field)), [], `${definition.name} should not expose runtime control fields`);
	}
	assert.doesNotMatch(command("browser_tabs").promptGuidelines?.join(" ") ?? "", /start automation with browser_tabs list/i);
});

test("public schemas reject unknown tool inputs and enumerate canonical native commands", () => {
	const execute = command("browser_execute");
	assert.deepEqual(execute.validateArguments?.({ script: "document.title", readOnly: true }), []);
	assert.deepEqual(execute.validateArguments?.({}), [{ code: "EXECUTE_SCRIPT_REQUIRED", path: "/script", message: "browser_execute requires script" }]);
	assert.equal(validateCommandArgs(execute.parameters, { script: "browserPilot.refs.target.click()", refs: { target: "bp-ref://control/1" } }).ok, true);
	assert.equal(validateCommandArgs(execute.parameters, { script: "return 1", refs: { "not-valid-name": "bp-ref://control/1" } }).ok, false);

	const invalid = validateCommandArgs(command("browser_command").parameters, { command: { cmd: "tabs" }, typo: true });
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.error, /unknown parameter "typo"/);
	const native = command("browser_command").parameters as { properties: { command: { properties: { cmd: { enum: string[] } } } } };
	assert.deepEqual(native.properties.command.properties.cmd.enum, publicNativeCommandNames());
	assert.equal(validateCommandArgs(command("browser_command").parameters, { command: { cmd: "batch", commands: [] } }).ok, false);
});

test("input.ref public protocol requires an opaque ref instead of a private target", () => {
	assert.equal(validateBridgeCommand({ cmd: "input.ref", action: "click", ref: "bp-ref://control/1" }, { allowMissingTabId: true }).ok, true);
	assert.equal(validateBridgeCommand({ cmd: "input.ref", action: "click", ref: "bp-ref://control/1", target: {} }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "input.ref", action: "click", ref: "bp-ref://control/1", target: {} }, { allowMissingTabId: true, allowResolvedTarget: true }).ok, true);
	assert.equal(validateBridgeCommand({ cmd: "input.ref", action: "click", target: {} }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "network.list", target: {} }, { allowMissingTabId: true, allowResolvedTarget: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "network.list", tabId: "7" }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "network.list", timeoutMs: 1.5 }, { allowMissingTabId: true }).ok, false);
});

test("every public native command has one closed canonical parameter schema", () => {
	const protocol = getNativeCommandProtocolSchema();
	const names = publicNativeCommandNames();
	for (const internal of ["batch", "bridge_wake", "persistent_cdp", "hook.list_sessions", "hook.list_targets", "hook.install_targets"]) assert.equal(names.includes(internal), false);
	assert.equal(names.includes("hook.clear"), false);
	assert.equal(new Set(names).size, names.length);
	const forbiddenFields = new Set(["browserSessionId", "tabId", "sessionId", "timeoutMs", "waitId", "networkSessionId", "targetId", "name", "persistent", "detachOnError", "protocolVersion", "bringToFront", "maxIdleMs"]);
	for (const name of names) {
		const params = protocol.commands[name]?.paramsSchema as { additionalProperties?: unknown; properties?: Record<string, unknown> } | undefined;
		assert.ok(params, `${name} should publish paramsSchema`);
		assert.equal(params.additionalProperties, false, `${name} paramsSchema should reject unknown fields`);
		assert.deepEqual(deepKeys(params).filter((field) => forbiddenFields.has(field)), [], `${name} should not expose runtime control fields`);
	}
	assert.deepEqual(Object.keys((protocol.commands.cdp.paramsSchema as { properties: Record<string, unknown> }).properties), ["method", "params"]);
	assert.equal(validateBridgeCommand({ cmd: "hook.install" }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "hook.install", targets: [] }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "hook.install", targets: ["console"] }, { allowMissingTabId: true }).ok, true);
	assert.equal(validateBridgeCommand({ cmd: "network.list", typo: true }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "transfer.download", url: "https://example.test/file", mode: "click" }, { allowMissingTabId: true }).ok, false);
});

test("browser_observe rejects contradictory freshness inputs", () => {
	assert.deepEqual(validateObserveArguments({ fresh: true, diff: true }), [{ code: "OBSERVE_FRESH_DIFF_CONFLICT", path: "/fresh", message: "browser_observe fresh:true cannot be combined with diff:true" }]);
	const properties = (command("browser_observe").parameters as { properties: Record<string, unknown> }).properties;
	for (const removed of ["maxChars", "outputPath", "timeoutMs", "maxNodes", "includeIframes", "baselinePath"]) assert.equal(removed in properties, false);
	assert.equal(validateBrowserCommandArguments(command("browser_observe"), { maxChars: 1000 }).ok, false);
	assert.equal(browserCommandDefinitions().some((definition) => definition.name === "browser_artifact"), false);
});

test("browser_tabs rejects unknown session arguments at the public validation boundary", () => {
	const validation = validateBrowserCommandArguments(command("browser_tabs"), { action: "selectSession", browserSessionId: "session-1" });
	assert.equal(validation.ok, false);
	if (!validation.ok) {
		assert.match(validation.error, /browserSessionId.*Unknown argument/);
		assert.equal(validation.issues[0]?.code, "UNKNOWN_ARGUMENT");
	}
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
