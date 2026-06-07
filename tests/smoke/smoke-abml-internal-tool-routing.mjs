import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { ToolCollectingAdapter as McpExtensionAdapter } from "../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";

const cwd = await mkdtemp(path.join(os.tmpdir(), "abml-internal-routing-"));
const adapter = new McpExtensionAdapter();
const commandCalls = [];
const fakeBridge = {
	queueDepth() { return 0; },
	leaseOwnerHash() { return undefined; },
	refreshTabs: async () => [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }],
	getTabs() { return [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }]; },
	snapshot() { return { browserSessionId: "default", defaultTabId: 7, selectionVersion: 3, tabs: [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }] }; },
	createObservationSnapshot(snapshot) { return { snapshotId: snapshot.snapshotId || `snap-${Date.now()}`, ttlMs: 60_000, expired: false, ...snapshot }; },
	async executeJavaScript(script) {
		commandCalls.push({ kind: "executeJavaScript", script: String(script).slice(0, 120) });
		return { id: "exec-1", acknowledged: true, tabId: 7, data: { content: "<h1>Checkout</h1>\nStatus: payment required", actionables: [{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 }], list_hints: [], url: "https://example.test/checkout", title: "Checkout", readyState: "complete", node_count: 12, truncated: false } };
	},
	async sendCommand(command) {
		commandCalls.push({ kind: "sendCommand", command });
		if (command.cmd === "cdp" && command.method === "Runtime.evaluate") {
			const expression = String(command.params?.expression || "");
			if (expression.includes("scan_extract") || expression.includes("collectActionables")) {
				return { id: "eval-1", acknowledged: true, tabId: 7, data: { result: { value: { url: "https://example.test/checkout", title: "Checkout", readyState: "complete", content: "<h1>Checkout</h1>\nStatus: payment required", node_count: 12, truncated: false, actionables: [{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 }], list_hints: [] } } } };
			}
			if (expression.includes("__PI_ABML_MUTATION_TICK__") && expression.includes("querySelectorAll(selector)")) {
				return { id: "eval-2", acknowledged: true, tabId: 7, data: { result: { value: { selector: "#pay", count: 1, unique: true, attached: true, visible: true, disabled: false, editable: false, inViewport: true, receivesEvents: true, notOccluded: true, focused: false, scrollable: true, point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, url: "https://example.test/checkout", text: "Pay now", mutationTick: 1 } } } };
			}
			if (expression.includes("querySelector(\"#pay\")") && expression.includes("mutationTick")) {
				return { id: "eval-3", acknowledged: true, tabId: 7, data: { result: { value: { url: "https://example.test/checkout", activeElementMatches: false, value: "clicked", text: "clicked", mutationTick: 2 } } } };
			}
			return { id: "eval-x", acknowledged: true, tabId: 7, data: { result: { value: { ok: true } } } };
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "Accessibility.getFullAXTree") {
			return { id: "ax-tree", acknowledged: true, tabId: 7, data: { result: { nodes: [{ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } }] } } };
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "DOM.getBoxModel") {
			return { id: "box-1", acknowledged: true, tabId: 7, data: { result: { border: [140, 240, 220, 240, 220, 272, 140, 272] } } };
		}
		return { id: "ok", acknowledged: true, tabId: 7, data: { ok: true } };
	},
};
registerBrowserTools(adapter, fakeBridge, async () => fakeBridge);
const observe = adapter.getTool("browser_observe");
const execute = adapter.getTool("browser_execute");
if (!observe || !execute) throw new Error("tools not registered");
try {
	const observed = await observe.execute("observe-1", { mode: "scan", tabId: 7, maxChars: 12000 }, undefined, undefined, { cwd, hasUI: false });
	const observeEnvelope = JSON.parse(observed.content[0].text);
	const executeMonitored = await execute.execute("exec-1", { script: "(() => ({ ok: true }))()", tabId: 7, monitor: true, maxChars: 12000 }, undefined, undefined, { cwd, hasUI: false });
	const executeEnvelope = JSON.parse(executeMonitored.content[0].text);
	const result = {
		ok: true,
		observeHasEntities: Array.isArray(observeEnvelope.summary?.focus?.primary_entities) && observeEnvelope.summary.focus.primary_entities.length >= 1,
		executeHasMonitor: executeEnvelope.summary?.monitor?.changed !== undefined || executeEnvelope.summary?.data?.monitor?.changed !== undefined || executeEnvelope.summary?.type === "bridgeResult",
		commandCalls,
	};
	console.log(JSON.stringify(result, null, 2));
} finally {
	await rm(cwd, { recursive: true, force: true }).catch(() => {});
}
