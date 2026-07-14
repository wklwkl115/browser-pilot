import test from "node:test";
import assert from "node:assert/strict";
import { connectionReadiness, connectionRecoveryCommands, extensionBuildCheck } from "../../src/apps/cli/connection.ts";

test("connection readiness rejects a connected stale extension", () => {
	assert.deepEqual(connectionReadiness({
		ok: true,
		running: true,
		readiness: "ready",
		extensionConnected: true,
		extension: { extensionStale: true, expectedBuild: "new", reportedBuild: "old" },
	}), { ready: false, readiness: "extension-stale", extensionStale: true });
});

test("connection readiness distinguishes a missing daemon", () => {
	assert.deepEqual(connectionReadiness(undefined), { ready: false, readiness: "no-daemon", extensionStale: false });
});

test("stale extension recovery reloads the unpacked build before reconnecting", () => {
	const commands = connectionRecoveryCommands(15_000, { extensionStale: true });
	assert.deepEqual(commands[0]?.argv, ["browser-pilot", "command", "--command", '{"cmd":"management","method":"reload"}', "--json"]);
	assert.match(commands[1]?.command ?? "", /connect --wait/);
});

test("doctor extension build checks expose stale build evidence", () => {
	assert.deepEqual(extensionBuildCheck({
		ok: true,
		running: true,
		extensionConnected: true,
		extension: { extensionStale: true, expectedBuild: "new", reportedBuild: "old" },
	}), { ok: false, code: "CLI_EXTENSION_STALE", reason: "build-mismatch", expectedBuild: "new", reportedBuild: "old" });
});
