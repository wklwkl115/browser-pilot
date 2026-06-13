import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { BrowserBridgeClientRegistry } from "../../../src/driver/BrowserBridgeClientRegistry.ts";
import { BrowserSessionRegistry } from "../../../src/driver/BrowserSessionRegistry.ts";
import { BrowserTabSessionRouter } from "../../../src/driver/BrowserTabSessionRouter.ts";
import { BrowserBridgeError } from "../../../src/driver/errors.ts";

function fakeSocket(): WebSocket {
	return { readyState: WebSocket.OPEN, close() {} } as unknown as WebSocket;
}

test("BrowserTabSessionRouter reports ambiguous duplicate tab ids until a browser is selected", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const a = fakeSocket();
	const b = fakeSocket();
	clients.register(a);
	clients.updateClientInfo(a, { id: "browser-a" });
	clients.register(b);
	clients.updateClientInfo(b, { id: "browser-b" });

	router.updateTabs([{ id: 7, active: true, url: "https://a.example" }], a);
	router.updateTabs([{ id: 7, active: true, url: "https://b.example" }], b);

	assert.throws(() => router.liveSessionForTabId(7), (error) => error instanceof BrowserBridgeError && error.code === "AMBIGUOUS_TAB_ID");
	router.selectBrowser(a);
	assert.equal(router.liveSessionForTabId(7)?.browserId, clients.browserIdForClient(a));
});

test("BrowserTabSessionRouter prunes stale disconnected tab sessions", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	router.updateTabs([{ id: 3, active: true, url: "https://example.test" }], ws);
	router.markClientDisconnected(ws);

	router.refreshSelectedSessionRefs(Date.now() + 6 * 60_000);

	assert.equal(router.getTabs({ includeDisconnected: true }).length, 0);
});

test("BrowserTabSessionRouter preserves tabHandle across replacement and follows stale numeric ids", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-a" });
	router.updateTabs([{ id: 3, active: true, url: "https://example.test/old" }], ws);
	const before = router.getTabs()[0]!;
	assert.match(before.tabHandle, /^tabh_/);

	router.applyTabReplacements([{ from: 3, to: 4, at: 1000 }], ws, 1000);
	router.updateTabs([{ id: 4, active: true, url: "https://example.test/old" }], ws);
	const after = router.getTabs()[0]!;
	assert.equal(after.tabId, 4);
	assert.equal(after.tabHandle, before.tabHandle);
	assert.equal(after.replacedFromTabId, 3);
	assert.equal(router.defaultTabId(), 4);

	const resolved = router.resolveTargetRef(3, undefined, "explicit");
	assert.equal(resolved?.tabId, 4);
	assert.equal(resolved?.replacedFrom, 3);
	assert.equal(resolved?.replacedByTabId, 4);
	assert.equal(resolved?.tabHandle, before.tabHandle);
	assert.equal(router.resolveTargetRef(before.tabHandle, undefined, "explicit")?.tabId, 4);
});

test("BrowserTabSessionRouter two consecutive tab replacements preserve handle across both hops", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-chain" });
	router.updateTabs([{ id: 10, active: true, url: "https://example.test/a" }], ws);
	const originalHandle = router.getTabs()[0]!.tabHandle;
	assert.match(originalHandle, /^tabh_/);

	// A → B
	router.applyTabReplacements([{ from: 10, to: 11, at: 1000 }], ws, 1000);
	router.updateTabs([{ id: 11, active: true, url: "https://example.test/b" }], ws, );
	assert.equal(router.getTabs()[0]!.tabHandle, originalHandle, "handle must survive first replacement");

	// B → C
	router.applyTabReplacements([{ from: 11, to: 12, at: 2000 }], ws, 2000);
	router.updateTabs([{ id: 12, active: true, url: "https://example.test/c" }], ws);
	const finalTab = router.getTabs().find((t) => t.tabId === 12 && !t.disconnectedAt);
	assert.ok(finalTab, "final tab C must be live");
	assert.equal(finalTab.tabHandle, originalHandle, "handle must survive second replacement");

	// Resolving original numeric id A must follow chain to C
	const resolved = router.resolveTargetRef(10, undefined, "explicit");
	assert.equal(resolved?.tabId, 12, "stale numeric id A must resolve to final tab C");
	assert.equal(resolved?.tabHandle, originalHandle, "resolved chain must expose the stable handle");
	assert.ok((resolved?.replacementHops ?? 0) >= 2, "hop count must reflect both hops");

	// Handle directly resolves to C
	assert.equal(router.resolveTargetRef(originalHandle, undefined, "explicit")?.tabId, 12);
});

test("BrowserTabSessionRouter hop bound stops resolution at MAX_REPLACEMENT_HOPS=3 and falls back to tabId", () => {
	// This test verifies the EXACT contract: when hops hit the bound (3), the
	// resolver returns the last resolved tabId without error (follow-then-stop).
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-hops" });

	// Build chain 1→2→3→4→5 (4 replacement records, exceeds MAX_REPLACEMENT_HOPS=3)
	router.updateTabs([{ id: 1, active: true, url: "https://example.test/1" }], ws);
	const at = (n: number) => n * 1000;
	for (let i = 1; i <= 4; i++) {
		router.applyTabReplacements([{ from: i, to: i + 1, at: at(i) }], ws, at(i));
		router.updateTabs([{ id: i + 1, active: true, url: `https://example.test/${i + 1}` }], ws);
	}

	// Only tab 5 is live; looking up 1 should follow 3 hops then stop
	// (hop limit is MAX_REPLACEMENT_HOPS=3, reaching tab 4 — tab 5 is 4 hops away)
	const resolved = router.resolveTargetRef(1, undefined, "explicit");
	// The resolver stops at hop limit and returns tabId=1 (could not follow all the way).
	// Concrete contract: when all MAX_REPLACEMENT_HOPS are exhausted without finding a live
	// session, resolveNumericTabId returns { tabId } (the original). No error thrown.
	assert.equal(resolved?.tabId, 1, "hop-bound fallback: returns original tabId, not an error");
	assert.equal(resolved?.replacedFrom, undefined, "hop-bound fallback must not report partial chain metadata");
});

test("BrowserTabSessionRouter replacement map pruned at MAX_REPLACEMENT_RECORDS=64", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-prune" });

	// Seed a live tab first
	router.updateTabs([{ id: 1, active: true, url: "https://example.test/base" }], ws);

	// Add 70 replacement records (exceeds MAX_REPLACEMENT_RECORDS=64)
	const now = Date.now();
	for (let i = 100; i < 170; i++) {
		router.applyTabReplacements([{ from: i, to: i + 1, at: now + i }], ws, now + i);
	}
	// The map must be pruned down to ≤64 entries (oldest evicted first)
	// Access the internal map via the sessions reference: use a cast-free probe via getTabs
	// count. Since pruneReplacements fires inside applyTabReplacements, check after the calls.
	// We verify via a cast to access the private field for assertion — only in test context.
	const routerAny = router as unknown as { replacements: Map<string, unknown> };
	assert.ok(routerAny.replacements.size <= 64, `replacement map must be bounded to 64, got ${routerAny.replacements.size}`);
	// Verify the literal cap value is 64 so an accidental change fails this test
	assert.equal(routerAny.replacements.size, 64, "replacement map must be exactly MAX_REPLACEMENT_RECORDS=64 after pruning overflow");
});

test("BrowserTabSessionRouter replacement map TTL expires old entries", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-ttl" });

	router.updateTabs([{ id: 1, active: true, url: "https://example.test/base" }], ws);
	const oldAt = Date.now() - 6 * 60_000; // older than REPLACEMENT_TTL_MS=5min
	router.applyTabReplacements([{ from: 1, to: 2, at: oldAt }], ws, oldAt);
	// Force a prune by calling applyTabReplacements with a current timestamp
	router.applyTabReplacements([], ws, Date.now());
	const routerAny = router as unknown as { replacements: Map<string, unknown> };
	assert.equal(routerAny.replacements.size, 0, "expired replacement records must be pruned by TTL");
});

test("BrowserTabSessionRouter reconnect rebinding: same extensionId + same tabId gets old handle", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);

	// First connection
	const ws1 = fakeSocket();
	clients.register(ws1);
	clients.updateClientInfo(ws1, { id: "ext-stable" });
	router.updateTabs([{ id: 42, active: true, url: "https://example.test/orig" }], ws1);
	const originalHandle = router.getTabs().find((t) => t.tabId === 42)!.tabHandle;
	assert.match(originalHandle, /^tabh_/);

	// Simulate SW idle: mark old client disconnected
	router.markClientDisconnected(ws1);
	clients.unregister(ws1);

	// New connection — same extensionId, new connection UUID
	const ws2 = fakeSocket();
	clients.register(ws2);
	clients.updateClientInfo(ws2, { id: "ext-stable" }); // same extensionId
	router.updateTabs([{ id: 42, active: true, url: "https://example.test/orig" }], ws2);

	const reboundTab = router.getTabs().find((t) => t.tabId === 42 && !t.disconnectedAt);
	assert.ok(reboundTab, "tab 42 must be live after reconnect");
	assert.equal(reboundTab.tabHandle, originalHandle, "handle must be rebound after reconnect with same extensionId");

	// Default selection must point to the rebound live session
	assert.equal(router.defaultTabId(), 42);
	assert.equal(router.defaultTabHandle(), originalHandle);
});

test("BrowserTabSessionRouter reconnect rebinding: different extensionId does NOT rebind — old handle yields error", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);

	const ws1 = fakeSocket();
	clients.register(ws1);
	clients.updateClientInfo(ws1, { id: "ext-original" });
	router.updateTabs([{ id: 7, active: true, url: "https://example.test/p" }], ws1);
	const oldHandle = router.getTabs().find((t) => t.tabId === 7)!.tabHandle;

	router.markClientDisconnected(ws1);
	clients.unregister(ws1);

	// New connection with a DIFFERENT extensionId (different browser install)
	const ws2 = fakeSocket();
	clients.register(ws2);
	clients.updateClientInfo(ws2, { id: "ext-different" });
	router.updateTabs([{ id: 7, active: true, url: "https://example.test/p" }], ws2);

	const newTab = router.getTabs().find((t) => t.tabId === 7 && !t.disconnectedAt);
	assert.ok(newTab, "tab 7 must be live");
	assert.notEqual(newTab.tabHandle, oldHandle, "different extensionId must mint a fresh handle");

	// The old handle must no longer resolve
	assert.throws(
		() => router.resolveTargetRef(oldHandle, undefined, "explicit"),
		(error) => error instanceof BrowserBridgeError && error.code === "TAB_NOT_FOUND",
		"old handle must throw TAB_NOT_FOUND after different-extension reconnect",
	);
});

test("BrowserTabSessionRouter tracks manual activation as the implicit target", () => {
	const clients = new BrowserBridgeClientRegistry(18765);
	const browserSessions = new BrowserSessionRegistry();
	const router = new BrowserTabSessionRouter(clients, browserSessions);
	const ws = fakeSocket();
	clients.register(ws);
	clients.updateClientInfo(ws, { id: "browser-a" });
	router.updateTabs([
		{ id: 10, active: true, url: "https://example.test/a", windowId: 1 },
		{ id: 11, active: false, url: "https://example.test/b", windowId: 1 },
	], ws);
	assert.equal(router.defaultTabId(), 10);

	router.recordTabActivation({ tabId: 11, windowId: 1, at: 1234 }, ws);
	assert.equal(router.defaultTabId(), 11);
	assert.equal(router.fallbackExecutionTarget()?.tabId, 11);
});
