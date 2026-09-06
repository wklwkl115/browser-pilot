import assert from "node:assert/strict";
import test from "node:test";
import { browserCommandDefinitions } from "../../src/commands/commandDefinitions.ts";
import { validateBrowserCommandArguments } from "../../src/commands/commandValidation.ts";
import { selectDiffBaselineSnapshot } from "../../src/commands/observeCommand.ts";
import { validateCommandArgs } from "../../src/validation/commandArgs.ts";
import { getNativeCommandProtocolSchema, validateBridgeCommand } from "../../src/types/nativeProtocol.ts";
import {
	coreNativeCommandNames,
	isPublicNativeCommand,
	nativeCommandTier,
	publicNativeCommandNames,
} from "../../src/commands/nativeCommandAccess.ts";

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

test("public tools expose operation observation while keeping private routing fields internal", () => {
	const definitions = browserCommandDefinitions();
	assert.deepEqual(
		definitions.map((definition) => definition.name),
		[
			"browser_tabs",
			"browser_command",
			"browser_execute",
			"browser_observe",
			"browser_screenshot",
			"browser_operation",
		],
	);
	assert.deepEqual(
		Object.keys((command("browser_execute").parameters as { properties: Record<string, unknown> }).properties),
		["script", "refs", "readOnly", "expect", "business", "verificationWaitMs", "targetRef"],
	);
	assert.deepEqual(
		Object.keys((command("browser_command").parameters as { properties: Record<string, unknown> }).properties),
		["command", "expect", "business", "verificationWaitMs", "targetRef"],
	);
	const forbiddenFields = new Set(["browserSessionId", "tabId", "sessionId", "timeoutMs", "targetId"]);
	for (const definition of definitions) {
		assert.deepEqual(
			deepKeys(definition.parameters).filter((field) => forbiddenFields.has(field)),
			[],
			`${definition.name} should not expose runtime control fields`,
		);
	}
	assert.doesNotMatch(
		command("browser_tabs").promptGuidelines?.join(" ") ?? "",
		/start automation with browser_tabs list/i,
	);
});

test("public schemas reject unknown tool inputs and enumerate canonical native commands", () => {
	const execute = command("browser_execute");
	assert.deepEqual(execute.validateArguments?.({ script: "document.title", readOnly: true }), []);
	assert.equal(
		execute.validateArguments?.({ script: "return 1", readOnly: true, expect: "document.title === 'Done'" })[0]
			?.code,
		"EXECUTE_EXPECT_READ_ONLY",
	);
	assert.deepEqual(execute.validateArguments?.({}), [
		{ code: "EXECUTE_SCRIPT_REQUIRED", path: "/script", message: "browser_execute requires script" },
	]);
	assert.equal(
		validateCommandArgs(execute.parameters, {
			script: "browserPilot.refs.target.click()",
			refs: { target: "bp-ref://control/1" },
		}).ok,
		true,
	);
	assert.equal(
		validateCommandArgs(execute.parameters, {
			script: "browserPilot.refs.target.click()",
			refs: { target: "bp-ref://control/1" },
			expect: { ref: "bp-ref://control/1", state: { pressed: true } },
		}).ok,
		true,
	);
	assert.equal(
		validateCommandArgs(execute.parameters, {
			script: "return 1",
			expect: { ref: "bp-ref://control/1", state: {} },
		}).ok,
		false,
	);
	assert.equal(
		validateCommandArgs(execute.parameters, {
			script: "return 1",
			expect: { ref: "bp-ref://control/1", value: "secret" },
		}).ok,
		false,
	);
	assert.equal(
		validateCommandArgs(execute.parameters, {
			script: "return 1",
			refs: { "not-valid-name": "bp-ref://control/1" },
		}).ok,
		false,
	);

	const invalid = validateCommandArgs(command("browser_command").parameters, {
		command: { cmd: "tabs" },
		typo: true,
	});
	assert.equal(invalid.ok, false);
	if (!invalid.ok) assert.match(invalid.error, /unknown parameter "typo"/);
	const native = command("browser_command").parameters as {
		properties: { command: { properties: { cmd: { enum?: string[]; description: string } } } };
	};
	// The tool schema names core commands only; advanced families are discovered through the resource index.
	assert.equal(native.properties.command.properties.cmd.enum, undefined);
	for (const core of coreNativeCommandNames())
		assert.match(
			native.properties.command.properties.cmd.description,
			new RegExp(`\\b${core.replace(".", "\\.")}\\b`),
		);
	assert.match(native.properties.command.properties.cmd.description, /intercept\.\*.*hook\.\*.*ws\.\*/);
	assert.doesNotMatch(native.properties.command.properties.cmd.description, /hook\.install\b/);
	assert.equal(
		validateCommandArgs(command("browser_command").parameters, { command: { cmd: "batch", commands: [] } }).ok,
		true,
		"tool-level schema accepts any cmd string; the protocol validator rejects internal commands",
	);
	assert.equal(validateBridgeCommand({ cmd: "batch", commands: [] }, { publicCall: true }).ok, true);
	assert.equal(isPublicNativeCommand({ cmd: "batch" }), false);
});

test("native command tiers keep everyday commands core and debugging families advanced", () => {
	const core = new Set(coreNativeCommandNames());
	const all = publicNativeCommandNames();
	for (const cmd of [
		"cdp",
		"input.ref",
		"input.keys",
		"wait.selector",
		"network.start",
		"network.list",
		"transfer.download",
		"html.get",
		"frame.evaluate",
	])
		assert.equal(core.has(cmd), true, `${cmd} should be core`);
	for (const cmd of ["hook.install", "intercept.install", "ws.open", "frame.addNewDocumentScript"]) {
		assert.equal(core.has(cmd), false, `${cmd} should be advanced`);
		assert.equal(nativeCommandTier(cmd), "advanced");
		assert.equal(all.includes(cmd), true, `${cmd} stays public`);
	}
	assert.ok(core.size < all.length / 2, "core surface should be well under half of the public catalog");
});

test("wait primitives are public, bounded, and reject internal knobs", () => {
	const publicNames = new Set(publicNativeCommandNames());
	for (const cmd of ["wait.navigation", "wait.loadState", "wait.networkIdle", "wait.selector"])
		assert.equal(publicNames.has(cmd), true, `${cmd} should be public`);
	for (const cmd of ["wait.navigate", "wait.navigateAndWait", "wait.any", "wait.all", "wait.cancel", "wait.diagnose"])
		assert.equal(publicNames.has(cmd), false, `${cmd} should stay internal`);

	const check = (command: Record<string, unknown>) =>
		validateBridgeCommand(command, { allowMissingTabId: true, publicCall: true });
	assert.equal(check({ cmd: "wait.loadState" }).ok, true);
	assert.equal(check({ cmd: "wait.loadState", state: "networkidle" }).ok, true);
	assert.equal(check({ cmd: "wait.loadState", state: "bogus" }).ok, false);
	assert.equal(check({ cmd: "wait.navigation", urlContains: "/dashboard", waitUntil: "complete" }).ok, true);
	assert.equal(check({ cmd: "wait.navigation", timeoutMs: 1000 }).ok, false);
	assert.equal(check({ cmd: "wait.networkIdle", idleMs: 800, maxInflight: 1 }).ok, true);
	assert.equal(check({ cmd: "wait.networkIdle", idleMs: 10 }).ok, false);
	assert.equal(check({ cmd: "wait.selector", selector: "#done", state: "visible" }).ok, true);
	assert.equal(check({ cmd: "wait.selector" }).ok, false);
	assert.equal(check({ cmd: "wait.selector", selector: "#done", waitId: "x" }).ok, false);
});

test("input.ref public protocol accepts form verbs and their fields", () => {
	const check = (command: Record<string, unknown>) =>
		validateBridgeCommand(command, { allowMissingTabId: true, publicCall: true });
	const ref = "bp-ref://control/1";
	assert.equal(check({ cmd: "input.ref", action: "type", ref, text: "hi", clear: true }).ok, true);
	assert.equal(check({ cmd: "input.ref", action: "check", ref, checked: false }).ok, true);
	assert.equal(check({ cmd: "input.ref", action: "select", ref, label: "China" }).ok, true);
	assert.equal(check({ cmd: "input.ref", action: "select", ref, index: 2 }).ok, true);
	assert.equal(check({ cmd: "input.ref", action: "select", ref, index: -1 }).ok, false);
	assert.equal(check({ cmd: "input.ref", action: "focus", ref }).ok, true);
	assert.equal(check({ cmd: "input.ref", action: "toggle", ref }).ok, false);
});

test("input.ref public protocol requires an opaque ref instead of a private target", () => {
	assert.equal(
		validateBridgeCommand(
			{ cmd: "input.ref", action: "click", ref: "bp-ref://control/1" },
			{ allowMissingTabId: true },
		).ok,
		true,
	);
	assert.equal(
		validateBridgeCommand(
			{ cmd: "input.ref", action: "click", ref: "bp-ref://control/1", target: {} },
			{ allowMissingTabId: true },
		).ok,
		false,
	);
	assert.equal(
		validateBridgeCommand(
			{ cmd: "input.ref", action: "click", ref: "bp-ref://control/1", target: {} },
			{ allowMissingTabId: true, allowResolvedTarget: true },
		).ok,
		true,
	);
	assert.equal(
		validateBridgeCommand({ cmd: "input.ref", action: "click", target: {} }, { allowMissingTabId: true }).ok,
		false,
	);
	assert.equal(
		validateBridgeCommand(
			{
				cmd: "input.ref",
				action: "drag",
				ref: "bp-ref://region/1",
				visual: { point: { x: 0.2, y: 0.3 }, to: { x: 0.7, y: 0.8 } },
			},
			{ allowMissingTabId: true },
		).ok,
		true,
	);
	assert.equal(
		validateBridgeCommand(
			{
				cmd: "input.ref",
				action: "type",
				ref: "bp-ref://region/1",
				visual: { point: { x: 1.1, y: 0.3 } },
				text: "hello",
			},
			{ allowMissingTabId: true },
		).ok,
		false,
	);
	assert.equal(
		validateBridgeCommand(
			{ cmd: "network.list", target: {} },
			{ allowMissingTabId: true, allowResolvedTarget: true },
		).ok,
		false,
	);
	assert.equal(validateBridgeCommand({ cmd: "network.list", tabId: "7" }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "network.list", timeoutMs: 1.5 }, { allowMissingTabId: true }).ok, false);
});

test("every public native command has one closed canonical parameter schema", () => {
	const protocol = getNativeCommandProtocolSchema();
	const names = publicNativeCommandNames();
	for (const internal of [
		"batch",
		"bridge_wake",
		"management",
		"persistent_cdp",
		"hook.list_sessions",
		"hook.list_targets",
		"hook.install_targets",
	])
		assert.equal(names.includes(internal), false);
	assert.equal(names.includes("hook.clear"), false);
	assert.equal(new Set(names).size, names.length);
	const forbiddenFields = new Set([
		"browserSessionId",
		"tabId",
		"sessionId",
		"timeoutMs",
		"waitId",
		"networkSessionId",
		"targetId",
		"name",
		"persistent",
		"detachOnError",
		"protocolVersion",
		"bringToFront",
		"maxIdleMs",
	]);
	for (const name of names) {
		const params = protocol.commands[name]?.paramsSchema as
			{ additionalProperties?: unknown; properties?: Record<string, unknown> } | undefined;
		assert.ok(params, `${name} should publish paramsSchema`);
		assert.equal(params.additionalProperties, false, `${name} paramsSchema should reject unknown fields`);
		assert.deepEqual(
			deepKeys(params).filter((field) => forbiddenFields.has(field)),
			[],
			`${name} should not expose runtime control fields`,
		);
	}
	assert.deepEqual(
		Object.keys((protocol.commands.cdp.paramsSchema as { properties: Record<string, unknown> }).properties),
		["method", "params"],
	);
	assert.equal(validateBridgeCommand({ cmd: "hook.install" }, { allowMissingTabId: true }).ok, false);
	assert.equal(validateBridgeCommand({ cmd: "hook.install", targets: [] }, { allowMissingTabId: true }).ok, false);
	assert.equal(
		validateBridgeCommand({ cmd: "hook.install", targets: ["console"] }, { allowMissingTabId: true }).ok,
		true,
	);
	assert.equal(
		validateBridgeCommand(
			{ cmd: "hook.install", targets: ["console"], bufferSize: 10_001 },
			{ allowMissingTabId: true },
		).ok,
		false,
	);
	assert.equal(
		validateBridgeCommand(
			{ cmd: "hook.install", targets: ["console"], bufferSize: 1.5 },
			{ allowMissingTabId: true },
		).ok,
		false,
	);
	assert.equal(validateBridgeCommand({ cmd: "network.list", typo: true }, { allowMissingTabId: true }).ok, false);
	assert.equal(
		validateBridgeCommand(
			{ cmd: "transfer.download", url: "https://example.test/file", mode: "click" },
			{ allowMissingTabId: true },
		).ok,
		false,
	);
});

test("browser_observe exposes one observation mode", () => {
	const properties = (command("browser_observe").parameters as { properties: Record<string, unknown> }).properties;
	assert.deepEqual(Object.keys(properties), ["mode", "visual", "targetRef"]);
	assert.deepEqual((properties.mode as { enum: string[] }).enum, ["auto", "full", "diff"]);
	for (const removed of [
		"fresh",
		"diff",
		"maxChars",
		"outputPath",
		"timeoutMs",
		"maxNodes",
		"includeIframes",
		"baseline",
		"baselinePath",
		"baselineSnapshotId",
		"actionRef",
	])
		assert.equal(removed in properties, false);
	assert.equal(validateBrowserCommandArguments(command("browser_observe"), { maxChars: 1000 }).ok, false);
	assert.equal(
		validateBrowserCommandArguments(command("browser_observe"), {
			baseline: { saved: { path: "C:\\Windows\\win.ini" } },
		}).ok,
		false,
	);
	assert.equal(
		browserCommandDefinitions().some((definition) => definition.name === "browser_artifact"),
		false,
	);
});

test("browser_tabs rejects unknown session arguments at the public validation boundary", () => {
	const validation = validateBrowserCommandArguments(command("browser_tabs"), {
		action: "selectSession",
		browserSessionId: "session-1",
	});
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
		snapshot: () => ({
			browserSessionId: "session-1",
			defaultTabId: 7,
			tabs: [{ tabId: 7, generation: 1, targetGeneration: 1, pageEpoch: "page-1", url: "https://example.test/" }],
		}),
		resolveTargetTabId: (value: unknown) => (typeof value === "number" ? value : undefined),
		listObservationSnapshots: () => snapshots,
	};
}

test("diff baseline uses the newest valid snapshot from the current page", () => {
	const snapshots = [
		{
			snapshotId: "wrong-session",
			browserSessionId: "session-2",
			tabId: 7,
			pageIdentity: pageIdentity("session-2", 7),
			sourceMode: "scan",
			capturedAt: 50,
			ttlMs: 1_000,
			saved: { path: "wrong.json" },
		},
		{
			snapshotId: "wrong-page",
			browserSessionId: "session-1",
			tabId: 7,
			pageIdentity: pageIdentity("session-1", 7, "page-old"),
			sourceMode: "scan",
			capturedAt: 40,
			ttlMs: 1_000,
			saved: { path: "old.json" },
		},
		{
			snapshotId: "expired",
			browserSessionId: "session-1",
			tabId: 7,
			pageIdentity: pageIdentity("session-1", 7),
			sourceMode: "scan",
			capturedAt: 30,
			ttlMs: 1_000,
			expired: true,
			saved: { path: "expired.json" },
		},
		{
			snapshotId: "no-file",
			browserSessionId: "session-1",
			tabId: 7,
			pageIdentity: pageIdentity("session-1", 7),
			sourceMode: "scan",
			capturedAt: 25,
			ttlMs: 1_000,
		},
		{
			snapshotId: "older",
			browserSessionId: "session-1",
			tabId: 7,
			pageIdentity: pageIdentity("session-1", 7),
			sourceMode: "scan",
			capturedAt: 10,
			ttlMs: 1_000,
			saved: { path: "older.json" },
		},
		{
			snapshotId: "newest",
			browserSessionId: "session-1",
			tabId: 7,
			pageIdentity: pageIdentity("session-1", 7),
			sourceMode: "scan",
			capturedAt: 20,
			ttlMs: 1_000,
			saved: { path: "newest.json" },
		},
	];
	assert.equal(
		selectDiffBaselineSnapshot(baselineServer(snapshots) as never, { browserSessionId: "session-1", diff: true }),
		"newest",
	);
	assert.equal(
		selectDiffBaselineSnapshot(baselineServer(snapshots.slice(0, 2)) as never, {
			browserSessionId: "session-1",
			diff: true,
		}),
		undefined,
	);
});
