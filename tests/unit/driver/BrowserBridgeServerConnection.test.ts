// Cold-start connection grace: a command waits a bounded window for a not-yet-
// connected extension to dial into the bridge before failing, instead of hard-
// failing instantly. waitForExtensionReady is the non-throwing primitive behind
// that grace (BrowserBridgeCommandService.ensureExtensionReady reuses it).
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";

test("waitForExtensionReady resolves false within the bound when no extension connects", async () => {
	const server = new BrowserBridgeServer();
	const startedAt = Date.now();
	const ready = await server.waitForExtensionReady(undefined, 200);
	const elapsed = Date.now() - startedAt;
	assert.equal(ready, false, "no extension is connected, so the grace expires to false");
	assert.ok(elapsed >= 150, "honors the bounded wait instead of returning instantly");
	assert.ok(elapsed < 2_000, "never throws and returns near the deadline, not after a long hang");
});

test("waitForExtensionReady returns immediately with a zero bound", async () => {
	const server = new BrowserBridgeServer();
	const startedAt = Date.now();
	const ready = await server.waitForExtensionReady(undefined, 0);
	assert.equal(ready, false);
	assert.ok(Date.now() - startedAt < 150, "a zero/disabled grace must not block");
});
