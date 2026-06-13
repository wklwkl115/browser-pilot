import test from "node:test";
import assert from "node:assert/strict";
import { maybeTemporalProfileSample } from "../../../evals/browser-workflows/runner.mjs";

test("browser workflow runner extracts browser_execute temporal verdict from rendered execution effect", () => {
	const toolResult = {
		content: [{
			type: "text",
			text: JSON.stringify({
				tool: "browser_execute",
				operation: { operationId: "op-1", command: "javascript" },
				execution: {
					effect: {
						targetRef: "pi-ref://control/pay",
						temporal: {
							verdict: { status: "possibly_stale", confidence: "bounded", reasons: ["target_stale_before_dispatch", "target_region_dirty"] },
							frontier: { next: "reobserve" },
						},
					},
				},
			}),
		}],
	};

	const sample = maybeTemporalProfileSample(toolResult, { tabId: 7, timeoutMs: 1000 }, { evalId: "eval-1" }, { tool: "browser_execute", elapsedMs: 12 });

	assert.deepEqual(sample, {
		operationId: "op-1",
		tool: "browser_execute",
		command: "javascript",
		target: { tabId: 7, targetRef: "pi-ref://control/pay" },
		deadlineMs: 1000,
		elapsedMs: 12,
		verdict: "possibly_stale",
		reasons: ["target_stale_before_dispatch", "target_region_dirty"],
		recovery: "reobserve",
	});
});
