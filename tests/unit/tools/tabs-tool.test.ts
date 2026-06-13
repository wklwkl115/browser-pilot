import test from "node:test";
import assert from "node:assert/strict";
import { registerTabsTool } from "../../../src/tools/registerTabsTool.ts";
import { ToolCollectingAdapter } from "../../../src/frontend/toolCollector.ts";

function registerFakeTabsTool(snapshotOverride?: Record<string, unknown>) {
	const adapter = new ToolCollectingAdapter();
	let snapshotCalls = 0;
	let observationSnapshotCalls = 0;
	const server = {
		async refreshTabs() {
			return [{ id: "browser-1:7", tabId: 7, browserId: "browser-1", targetRef: "tabh_browser1_existing_g1", tabHandle: "tabh_browser1_existing_g1", active: true, url: "https://example.test/", title: "Example", bridge: { id: "bridge-1", userAgent: "ua" } }];
		},
		async createTab() {
			return {
				id: "create-1",
				acknowledged: true,
				data: { id: 8, tabId: 8, url: "https://created.example/", targetRef: "tabh_browser1_created_g1", tabHandle: "tabh_browser1_created_g1" },
				target: { source: "none", implicit: false, selectionVersionAtDispatch: 1 },
				createdTarget: { browserSessionId: "default", tabId: 8, targetRef: "tabh_browser1_created_g1", tabHandle: "tabh_browser1_created_g1", source: "explicit", implicit: false, selectionVersionAtDispatch: 1 },
				createdTab: { id: "browser-1:8", browserId: "browser-1", tabId: 8, targetRef: "tabh_browser1_created_g1", tabHandle: "tabh_browser1_created_g1", url: "https://created.example/" },
			};
		},
		snapshot() {
			snapshotCalls += 1;
			return snapshotOverride ?? { running: true, extensionConnected: true, tabs: [{ id: 7, url: "https://example.test/" }] };
		},
		listObservationSnapshots() {
			observationSnapshotCalls += 1;
			return [];
		},
	};
	registerTabsTool({ pi: adapter as any, ensureStarted: async () => server as any });
	const tool = adapter.getTool("browser_tabs");
	if (!tool) throw new Error("browser_tabs not registered");
	return { tool, snapshotCalls: () => snapshotCalls, observationSnapshotCalls: () => observationSnapshotCalls };
}

test("browser_tabs list skips expensive transport details when CLI context requests omission", async () => {
	const direct = registerFakeTabsTool();
	const directResult = await direct.tool.execute("tabs-direct", { action: "list", maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	assert.equal(direct.snapshotCalls(), 1, "direct execution keeps snapshot details for diagnostics");
	assert.equal(direct.observationSnapshotCalls(), 1, "direct execution keeps observation snapshot diagnostics");
	assert.ok((directResult.details?.snapshot as Record<string, unknown> | undefined)?.running === true);

	const cli = registerFakeTabsTool();
	const cliResult = await cli.tool.execute("tabs-cli", { action: "list", maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false, omitTransportDetails: true });
	assert.equal(cli.snapshotCalls(), 1, "CLI list still builds the compact top-level bridge from one snapshot");
	assert.equal(cli.observationSnapshotCalls(), 0, "CLI transport omission avoids building details-only observation snapshot diagnostics");
	assert.deepEqual(cliResult.details, { truncated: false, originalLength: directResult.details?.originalLength }, "CLI transport details keep only jsonResult preview metadata");
	assert.deepEqual(JSON.parse(cliResult.content[0].text), JSON.parse(directResult.content[0].text), "omitting transport details does not alter rendered content");
});

test("browser_tabs list hoists bridge by default and keeps per-tab bridge behind compatibility flag", async () => {
	const compact = registerFakeTabsTool();
	const compactResult = await compact.tool.execute("tabs-compact", { action: "list", maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	const compactJson = JSON.parse(compactResult.content[0].text) as Record<string, any>;
	assert.equal(compactJson.tabCount, 1);
	assert.ok(Array.isArray(compactJson.tabs));
	assert.equal(compactJson.tabs[0].id, "tabh_browser1_existing_g1");
	assert.equal(compactJson.tabs[0].tabSessionId, "browser-1:7");
	assert.equal(compactJson.tabs[0].targetRef, "tabh_browser1_existing_g1");
	assert.equal(compactJson.tabs[0].tabId, 7);
	assert.equal("bridge" in compactJson.tabs[0], false, "default list omits repeated per-tab bridge block");
	assert.ok(compactJson.bridge?.running === true, "shared bridge diagnostics are hoisted to top-level");

	const full = registerFakeTabsTool();
	const fullResult = await full.tool.execute("tabs-full", { action: "list", includeBridgePerTab: true, maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	const fullJson = JSON.parse(fullResult.content[0].text) as Record<string, any>;
	assert.equal(fullJson.tabs[0].bridge?.id, "bridge-1", "compatibility flag preserves old per-tab bridge block");
});

test("browser_tabs snapshot redacts lease and uiLock owners while preserving expiry diagnostics", async () => {
	const rawSnapshot = {
		browserSessionId: "current-session",
		running: true,
		extensionConnected: true,
		tabs: [],
		leases: [{
			id: "lease-1",
			browserSessionId: "foreign-session",
			tabSessionId: "foreign-tab-session",
			browserId: "browser-1",
			tabId: 7,
			explicit: true,
			createdAt: 1_000,
			lastSeenAt: 2_000,
		}],
		uiLock: {
			browserSessionId: "foreign-session",
			toolName: "browser_pick",
			createdAt: 1_100,
			lastSeenAt: 2_100,
			count: 1,
		},
	};
	const { tool } = registerFakeTabsTool(rawSnapshot);
	const result = await tool.execute("tabs-snapshot", { action: "snapshot", maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	const json = JSON.parse(result.content[0].text) as Record<string, any>;
	assert.equal(JSON.stringify(json).includes("foreign-session"), false, "snapshot output must not expose raw foreign browserSessionId");
	assert.equal(JSON.stringify(json).includes("foreign-tab-session"), false, "snapshot output must not expose raw foreign tabSessionId");
	assert.equal(typeof json.bridge.leases[0].browserSessionHash, "string");
	assert.equal(typeof json.bridge.leases[0].tabSessionHash, "string");
	assert.equal(typeof json.bridge.leases[0].expiresAt, "number");
	assert.equal(typeof json.bridge.leases[0].remainingMs, "number");
	assert.equal(typeof json.bridge.uiLock.browserSessionHash, "string");
	assert.equal(typeof json.bridge.uiLock.expiresAt, "number");
});

test("browser_tabs create returns the created targetRef for follow-up tab-scoped calls", async () => {
	const { tool } = registerFakeTabsTool();
	const result = await tool.execute("tabs-create", { action: "create", url: "https://created.example/", maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	const json = JSON.parse(result.content[0].text) as Record<string, any>;
	assert.equal(json.id, "tabh_browser1_created_g1");
	assert.equal(json.requestId, "create-1");
	assert.equal(json.targetRef, "tabh_browser1_created_g1");
	assert.equal(json.tabHandle, "tabh_browser1_created_g1");
	assert.equal(json.tabId, 8);
	assert.equal(json.createdTarget.targetRef, "tabh_browser1_created_g1");
	assert.equal(json.createdTab.id, "tabh_browser1_created_g1");
	assert.equal(json.createdTab.tabSessionId, "browser-1:8");
	assert.equal(json.createdTab.targetRef, "tabh_browser1_created_g1");
	assert.equal(json.data.tabId, 8);
	assert.equal(json.data.targetRef, "tabh_browser1_created_g1");
	assert.equal(json.target.source, "none");
});
