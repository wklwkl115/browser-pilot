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
