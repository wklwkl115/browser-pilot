import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";
import { BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from "../../../src/driver/BrowserSessionRegistry.ts";

test("BrowserSessionRegistry keeps a stable default session and manages explicit sessions", () => {
	const sessions = new BrowserSessionRegistry();
	const defaultSession = sessions.defaultSession();
	assert.equal(defaultSession.id, DEFAULT_BROWSER_SESSION_ID);
	const created = sessions.create("secondary");
	assert.equal(created.name, "secondary");
	const selected = sessions.selectSession(created.id);
	assert.equal(selected.id, created.id);
	sessions.close(created.id);
	assert.equal(sessions.selectedSession().id, DEFAULT_BROWSER_SESSION_ID);
});

test("BrowserSessionRegistry require rejects unknown explicit session ids instead of auto-creating", () => {
	const sessions = new BrowserSessionRegistry();
	assert.equal(sessions.getIfExists("missing-session"), undefined);
	assert.throws(() => sessions.require("missing-session"), (error) => error instanceof BrowserBridgeError && error.code === "SESSION_NOT_FOUND");
	assert.equal(sessions.list().length, 1);
});
