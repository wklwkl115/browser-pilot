import test from "node:test";
import assert from "node:assert/strict";
import { assertMatureBridgeProcessResult, detectMatureBridgeLauncher, matureBridgeFailureRecord, matureBridgeToolError } from "../../../../src/tools/webSecurity/shared/matureBridge.ts";

test("matureBridgeToolError creates structured webSecurity error envelope", () => {
	const error = matureBridgeToolError("MATURE_BRIDGE_TARGET_REQUIRED", "target missing", { bridgeName: "sqlmap", token: "secret" }) as Error & { code?: string; details?: Record<string, unknown> };
	assert.equal(error.code, "MATURE_BRIDGE_TARGET_REQUIRED");
	assert.equal(error.details?.domain, "webSecurity");
	assert.equal(error.details?.bridgeName, "sqlmap");
	assert.equal(error.details?.token, "secret");
	assert.equal(Object.hasOwn(error, "stack"), false);
});

test("detectMatureBridgeLauncher reports structured not-found diagnostics for explicit path", () => {
	assert.throws(() => detectMatureBridgeLauncher({
		bridgeName: "sqlmap",
		explicitPath: "__pi_missing_sqlmap__",
		explicitArgs: [],
		envPathVar: "PI_SQLMAP_PATH",
		envArgsVar: "PI_SQLMAP_ARGS",
		autoCandidates: [],
		versionArgs: ["--version"],
		successPattern: /sqlmap/i,
		allowLauncherOverride: true,
	}), (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "MATURE_BRIDGE_LAUNCHER_NOT_FOUND");
		assert.equal(error.details?.source, "param");
		assert.equal(error.details?.bridgeName, "sqlmap");
		assert.ok(Array.isArray(error.details?.attempts));
		return true;
	});
});

test("detectMatureBridgeLauncher returns auto candidate when version probe succeeds", () => {
	const launcher = detectMatureBridgeLauncher({
		bridgeName: "node-fixture",
		envPathVar: "PI_FAKE_PATH",
		envArgsVar: "PI_FAKE_ARGS",
		autoCandidates: [{ command: process.execPath, preArgs: ["-e", "console.log('node-fixture version 1.0')"], source: "auto" }],
		versionArgs: [],
		successPattern: /node-fixture version/i,
	});
	assert.equal(launcher.command, process.execPath);
	assert.equal(launcher.source, "auto");
});

test("detectMatureBridgeLauncher requires explicit opt-in for launcher overrides", () => {
	assert.throws(() => detectMatureBridgeLauncher({
		bridgeName: "sqlmap",
		explicitPath: process.execPath,
		envPathVar: "PI_SQLMAP_PATH",
		envArgsVar: "PI_SQLMAP_ARGS",
		autoCandidates: [],
		versionArgs: ["--version"],
		successPattern: /node/i,
	}), (error: Error & { code?: string }) => {
		assert.equal(error.code, "MATURE_BRIDGE_LAUNCHER_OVERRIDE_REQUIRED");
		return true;
	});
});

test("detectMatureBridgeLauncher falls back to auto candidates when env path is stale", () => {
	const previousPath = process.env.PI_FAKE_FALLBACK_PATH;
	const previousArgs = process.env.PI_FAKE_FALLBACK_ARGS;
	process.env.PI_FAKE_FALLBACK_PATH = "__pi_missing_env_launcher__";
	process.env.PI_FAKE_FALLBACK_ARGS = "--ignored";
	try {
		const launcher = detectMatureBridgeLauncher({
			bridgeName: "node-fixture-fallback",
			envPathVar: "PI_FAKE_FALLBACK_PATH",
			envArgsVar: "PI_FAKE_FALLBACK_ARGS",
			envArgs: ["--ignored"],
			autoCandidates: [{ command: process.execPath, preArgs: ["-e", "console.log('node-fixture fallback 1.0')"], source: "auto" }],
			versionArgs: [],
			successPattern: /node-fixture fallback/i,
			allowLauncherOverride: true,
		});
		assert.equal(launcher.command, process.execPath);
		assert.equal(launcher.source, "auto");
	} finally {
		if (previousPath === undefined) delete process.env.PI_FAKE_FALLBACK_PATH;
		else process.env.PI_FAKE_FALLBACK_PATH = previousPath;
		if (previousArgs === undefined) delete process.env.PI_FAKE_FALLBACK_ARGS;
		else process.env.PI_FAKE_FALLBACK_ARGS = previousArgs;
	}
});

test("assertMatureBridgeProcessResult converts ETIMEDOUT into structured process timeout", () => {
	assert.throws(() => assertMatureBridgeProcessResult("nuclei", { command: "nuclei", preArgs: [], source: "auto" }, ["-jsonl"], {
		pid: 0,
		output: [],
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGTERM",
		error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
	} as any, 1_000), (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "MATURE_BRIDGE_PROCESS_TIMEOUT");
		assert.equal(error.details?.bridgeName, "nuclei");
		return true;
	});
});

test("matureBridgeFailureRecord redacts sensitive details for structured failures", () => {
	const record = matureBridgeFailureRecord(matureBridgeToolError("MATURE_BRIDGE_LAUNCH_FAILED", "launch failed", { bridgeName: "sqlmap", cookie: "sid=abc", nested: { authorization: "Bearer secret" } }));
	assert.equal(record.code, "MATURE_BRIDGE_LAUNCH_FAILED");
	assert.equal(record.error, "launch failed");
	assert.equal((record.details as Record<string, unknown>).bridgeName, "sqlmap");
	assert.equal(JSON.stringify(record).includes("sid=abc"), false);
	assert.equal(JSON.stringify(record).includes("Bearer secret"), false);
});
