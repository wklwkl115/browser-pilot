import test from "node:test";
import assert from "node:assert/strict";
import { registerTabsTool } from "../../../src/tools/registerTabsTool.ts";
import { ToolCollectingAdapter } from "../../../src/frontend/toolCollector.ts";

function registerFakeTabsTool() {
	const adapter = new ToolCollectingAdapter();
	let snapshotCalls = 0;
	let observationSnapshotCalls = 0;
	const server = {
		async refreshTabs() {
			return [{ id: 7, tabId: 7, browserId: "browser-1", active: true, url: "https://example.test/", title: "Example", bridge: { id: "bridge-1", userAgent: "ua" } }];
		},
		snapshot() {
			snapshotCalls += 1;
			return { running: true, extensionConnected: true, tabs: [{ id: 7, url: "https://example.test/" }] };
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
	assert.equal(compactJson.tabs[0].tabId, 7);
	assert.equal("bridge" in compactJson.tabs[0], false, "default list omits repeated per-tab bridge block");
	assert.ok(compactJson.bridge?.running === true, "shared bridge diagnostics are hoisted to top-level");

	const full = registerFakeTabsTool();
	const fullResult = await full.tool.execute("tabs-full", { action: "list", includeBridgePerTab: true, maxChars: 10_000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	const fullJson = JSON.parse(fullResult.content[0].text) as Record<string, any>;
	assert.equal(fullJson.tabs[0].bridge?.id, "bridge-1", "compatibility flag preserves old per-tab bridge block");
});
