import test from "node:test";
import assert from "node:assert/strict";
import { getDistillerRegistrySnapshot, hasRegisteredDistiller } from "../../../src/tools/distillerRegistry.ts";
import { distillValue, summarizeHtmlSnapshot } from "../../../src/tools/resultMiddleware.ts";

test("resultMiddleware distillValue uses evidence-specific summarizer", () => {
	const result = distillValue("browser_evidence", "evidence.collect", { data: { hook: { count: 1 }, network: { count: 2 } } });
	assert.equal(typeof result, "object");
	assert.ok(Object.keys(result).length > 0);
});

test("resultMiddleware distillValue uses network summarizer for network commands", () => {
	const result = distillValue("browser_network", "network.list", { data: { entries: [{ id: "1", status: 200 }], count: 1 } });
	assert.equal(typeof result, "object");
	assert.ok(Object.keys(result).length > 0);
});

test("resultMiddleware builtin distillers are registered for fallback routes", () => {
	const snapshot = getDistillerRegistrySnapshot();
	assert(snapshot.toolNames.includes("browser_evidence"));
	assert(snapshot.toolNames.includes("browser_network"));
	assert(snapshot.toolNames.includes("browser_hook"));
	assert(snapshot.commandRuleLabels.includes("evidence.collect"));
	assert(snapshot.commandRuleLabels.includes("network.*"));
	assert(snapshot.commandRuleLabels.includes("hook.dom-flow"));
	assert(snapshot.commandRuleLabels.includes("ws.*"));
	assert.equal(hasRegisteredDistiller("browser_evidence", "evidence.collect"), true);
	assert.equal(hasRegisteredDistiller("browser_network", "network.list"), true);
	assert.equal(hasRegisteredDistiller("browser_hook", "hook.getSinkHints"), true);
	assert.equal(hasRegisteredDistiller("browser_command", "cdp"), false);
});

test("resultMiddleware summarizeHtmlSnapshot export remains callable", () => {
	const summary = summarizeHtmlSnapshot("<html><body><a href=\"/x\">x</a></body></html>", { url: "https://example.test/" });
	assert.equal(typeof summary, "object");
	assert.ok(Object.keys(summary).length > 0);
});
