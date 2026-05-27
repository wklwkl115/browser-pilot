import test from "node:test";
import assert from "node:assert/strict";
import { distilledJsonResult, distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

function textOf(result: { content: Array<{ text: string }> }) {
	return result.content.map((item) => item.text).join("\n");
}

test("distilledJsonResult summary mode emits compact envelope", async () => {
	const result = await distilledJsonResult({ ok: true, data: { values: Array.from({ length: 50 }, (_, i) => i) } }, {
		toolName: "browser_network",
		command: "network.list",
		maxChars: 4000,
		fallbackName: "unit.json",
		detailLevel: "summary",
	});
	const text = textOf(result);
	assert.ok(text.includes('"tool": "browser_network"'));
	assert.ok(text.includes('"detailLevel": "summary"'));
});

test("distilledJsonResult full mode redacts sensitive evidence", async () => {
	const result = await distilledJsonResult({ headers: { Authorization: "Bearer secret" } }, {
		toolName: "browser_command",
		command: "cdp",
		maxChars: 200,
		fallbackName: "sensitive.json",
		detailLevel: "full",
	});
	const text = textOf(result);
	assert.equal(text.includes("secret"), false);
	assert.ok(text.includes("browser_command"));
});

test("distilledTextResult summary mode emits compact artifact-guided output", async () => {
	const result = await distilledTextResult("hello", {
		toolName: "browser_observe",
		command: "scan",
		maxChars: 4000,
		fallbackName: "observe.txt",
		detailLevel: "summary",
		summary: {
			artifact_hints: { preferredReads: [{ jsonPath: "focus.primary_actions" }] },
			truncated: true,
		},
	});
	const text = textOf(result);
	assert.ok(text.includes("browser_observe"));
	assert.ok(text.includes("summary") || text.includes("focus.primary_actions") || text.includes("truncated"));
});
