import test from "node:test";
import assert from "node:assert/strict";
import { distillValue } from "../../../src/tools/resultMiddleware.ts";

test("resultMiddleware distills hook.getNodeListeners into compact DOM flow summary", () => {
	const result = distillValue("browser_hook", "hook.getNodeListeners", {
		data: {
			selector: "#pay",
			node: { tagName: "BUTTON", id: "pay" },
			listeners: [
				{ type: "click", useCapture: false, passive: true, once: false, handler: { url: "fixture.js", line: 12, column: 3, functionName: "onPay" } },
			],
			count: 1,
		},
	});
	assert.equal(result.selector, "#pay");
	assert.equal(result.count, 1);
	assert.equal(typeof result.listeners, "object");
	assert.equal(Array.isArray(result.eventTypeCounts), true);
});

test("resultMiddleware distills hook.getListenerChain into compact chain summary", () => {
	const result = distillValue("browser_hook", "hook.getListenerChain", {
		data: {
			selector: "#pay",
			node: { tagName: "BUTTON", id: "pay" },
			chain: [
				{ index: 0, eventType: "click", flags: { capture: false, passive: false, once: true }, handler: { url: "fixture.js", line: 12, functionName: "onPay" } },
			],
			count: 1,
		},
	});
	assert.equal(result.selector, "#pay");
	assert.equal(result.count, 1);
	assert.equal(typeof result.chain, "object");
	assert.equal(Array.isArray(result.eventTypeCounts), true);
});

test("resultMiddleware distills hook.getSinkHints into compact sink summary", () => {
	const result = distillValue("browser_hook", "hook.getSinkHints", {
		data: {
			selector: "#pay",
			node: { tagName: "BUTTON", id: "pay" },
			hints: [{ kind: "inline-handler", eventType: "click", suspicious: true, detail: "innerHTML = value" }],
			sinks: [{ selector: "#sink", innerHTML: "<span>paid</span>", text: "paid" }],
			count: 1,
		},
	});
	assert.equal(result.selector, "#pay");
	assert.equal(result.count, 1);
	assert.equal(typeof result.hints, "object");
	assert.equal(typeof result.sinks, "object");
	assert.equal(Array.isArray(result.hintKindCounts), true);
});
