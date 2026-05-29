import test from "node:test";
import assert from "node:assert/strict";
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
