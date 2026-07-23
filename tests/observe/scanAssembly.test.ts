import assert from "node:assert/strict";
import test from "node:test";
import { assembleScanSummary } from "../../src/commands/observe/scanAssembly.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";

test("successful ABML assembly does not require scan fallback entities", () => {
	const entity: Entity = {
		ref: "bp-ref://control/submit",
		kind: "control",
		role: "button",
		name: "Submit",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom",
	};
	const result = assembleScanSummary({
		server: {} as BrowserCommandRuntimePort,
		params: {},
		summaryData: pageWorldScanBundle(),
		browserSessionId: undefined,
		abmlEntities: [entity],
		abmlDiff: undefined,
		baseline: undefined,
		causal: undefined,
		ledgerDeltaFields: {},
	});
	assert.equal(result.summary.abmlIntegrated, true);
	assert.deepEqual(result.envelopeEntities, [entity]);
});

test("ABML assembly attributes post-action requests to the recorded action ref", () => {
	const actionRef = "bp-ref://control/like";
	const entity: Entity = {
		ref: actionRef,
		kind: "control",
		role: "button",
		name: "Like",
		state: { visible: true, occluded: false, disabled: false, focused: false, pressed: true, editable: false, inViewport: true },
		source: "dom",
	};
	const result = assembleScanSummary({
		server: {} as BrowserCommandRuntimePort,
		params: {},
		summaryData: pageWorldScanBundle(),
		browserSessionId: undefined,
		abmlEntities: [entity],
		abmlDiff: undefined,
		baseline: undefined,
		causal: { sinceSeq: 0, requests: [{ ref: "bp-ref://network/like", at: 20, initiatorType: "script" }] },
		action: { ref: actionRef, verb: "input.ref", at: 10 },
		ledgerDeltaFields: {},
	});
	assert.deepEqual(result.envelopeEntities[0]?.relations, [{
		type: "triggered",
		targetRef: "bp-ref://network/like",
		source: "timing",
		confidence: "medium",
		evidence: { since: 0, initiatorType: "script" },
	}]);
	const missingAction = assembleScanSummary({
		server: {} as BrowserCommandRuntimePort,
		params: {},
		summaryData: pageWorldScanBundle(),
		browserSessionId: undefined,
		abmlEntities: [entity],
		abmlDiff: { appeared: [], disappeared: [], changed: [], focusedRef: actionRef },
		baseline: undefined,
		causal: { sinceSeq: 0, requests: [{ ref: "bp-ref://network/like", at: 20, initiatorType: "script" }] },
		action: { ref: "bp-ref://control/missing", verb: "input.ref", at: 10 },
		ledgerDeltaFields: {},
	});
	assert.equal(missingAction.envelopeEntities[0]?.relations, undefined);
});
