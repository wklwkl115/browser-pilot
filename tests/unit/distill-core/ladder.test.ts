import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../../../src/utils/json.ts";
import { fitEnvelopeBudget, fitSummaryBudget, type BudgetedEnvelope } from "../../../src/distill-core/ladder.ts";

test("fitSummaryBudget compacts through rung limits before scalar fallback", () => {
	const summary = {
		title: "large summary",
		textPreview: "x".repeat(1_200),
		items: Array.from({ length: 30 }, (_, index) => ({ index, label: `row ${index}`, body: "detail ".repeat(20) })),
		table: { columns: ["name"], rows: Array.from({ length: 30 }, (_, index) => [`row ${index} ${"pad ".repeat(20)}`]), count: 30 },
	};
	const fitted = fitSummaryBudget(summary, 2_500);
	assert.ok(stableJson(fitted).length <= 2_500);
	assert.ok(Array.isArray(fitted.items));
	assert.ok(fitted.items.length < summary.items.length);
	assert.ok(typeof fitted.textPreview === "string");
	assert.ok(fitted.textPreview.endsWith("…"));
});

test("fitSummaryBudget marks low-priority omissions under tight budget", () => {
	const summary = {
		url: "https://example.test/",
		title: "Example",
		textPreview: "copy ".repeat(2_000),
		interactive: Array.from({ length: 100 }, (_, index) => `<button>${index}</button>`),
		matches: Array.from({ length: 100 }, (_, index) => ({ index, text: "match ".repeat(30) })),
	};
	const fitted = fitSummaryBudget(summary, 800);
	assert.ok(Array.isArray(fitted.summaryOmitted));
	assert.ok((fitted.summaryOmitted as unknown[]).includes("textPreview"));
});

test("fitSummaryBudget handles empty and impossible budgets", () => {
	assert.deepEqual(fitSummaryBudget({}, 10), {});
	assert.deepEqual(fitSummaryBudget({ blob: "x".repeat(2_000) }, 0), { summaryTruncatedToBudget: true });
	assert.deepEqual(fitSummaryBudget({ blob: "x".repeat(2_000) }, -10), { summaryTruncatedToBudget: true });
});

test("fitEnvelopeBudget compacts lifted keys and reports envelope omissions", () => {
	const envelope: BudgetedEnvelope = {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		summary: {
			url: "https://example.test/",
			title: "Example",
			textPreview: "copy ".repeat(1_000),
		},
		entities: Array.from({ length: 20 }, (_, index) => ({
			ref: `pi-ref://control/${index}`,
			kind: "control",
			role: "button",
			name: `Action ${index}`,
			hints: { selector: `#action-${index}`, payload: "x".repeat(300) },
		})),
		relations: { summary: { count: 20, text: "relations ".repeat(200) }, details: "x".repeat(2_000) },
		nextActions: ["read(pi-ref://control/0)"],
	};
	const fitted = fitEnvelopeBudget(envelope, 1_500);
	assert.ok(stableJson(fitted).length <= 1_500);
	assert.equal(fitted.summary.envelopeTruncatedToBudget, true);
	assert.ok(Array.isArray(fitted.summary.envelopeOmitted));
	assert.ok((fitted.diagnostics?.warnings as string[] | undefined)?.some((warning) => warning.startsWith("envelope_omitted:")));
});

test("fitEnvelopeBudget preserves essential fields on the final fallback", () => {
	const envelope: BudgetedEnvelope = {
		tool: "browser_observe",
		command: "scan",
		browserSessionId: "session-1",
		detailLevel: "summary",
		summary: { title: "Example", blob: "x".repeat(50_000) },
		entities: Array.from({ length: 100 }, (_, index) => ({ ref: `pi-ref://control/${index}`, name: "x".repeat(1_000) })),
		outline: Array.from({ length: 100 }, (_, index) => ({ index, text: "x".repeat(1_000) })),
		nextActions: ["read(pi-ref://control/0)", "click(pi-ref://control/0)", "read(pi-ref://control/1)"],
		saved: { path: ".pi/browser-artifacts/full.json" },
	};
	const fitted = fitEnvelopeBudget(envelope, 1);
	assert.equal(fitted.tool, "browser_observe");
	assert.equal(fitted.command, "scan");
	assert.equal(fitted.browserSessionId, "session-1");
	assert.equal(fitted.summary.envelopeTruncatedToBudget, true);
	assert.deepEqual(fitted.nextActions, ["read(pi-ref://control/0)", "click(pi-ref://control/0)"]);
	assert.deepEqual(fitted.saved, { path: ".pi/browser-artifacts/full.json" });
	assert.equal(fitted.entities, undefined);
	assert.equal(fitted.outline, undefined);
});
