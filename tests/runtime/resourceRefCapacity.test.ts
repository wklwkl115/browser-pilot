import assert from "node:assert/strict";
import test from "node:test";
import { resolveRefUriDetailed } from "../../src/resources/resourceRefs.ts";
import { REGISTERED_SCAN_REF_LIMITS, registerScanEntityRefs } from "../../src/scan/entityRefs.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

test("one oversized observation never publishes refs that it already evicted", () => {
	const actionables = Array.from({ length: REGISTERED_SCAN_REF_LIMITS.actionables + 500 }, (_, index) => ({
		index,
		selector: `#action-${index}`,
		tag: "button",
		role: "button",
		label: `Action ${index}`,
		clickable: true,
		visible: true,
		inViewport: true,
		hitOk: true,
		point: { x: 10, y: 10 },
		rect: { x: 0, y: 0, width: 20, height: 20 },
	}));
	const registered = registerScanEntityRefs(
		pageWorldScanBundle({ structure: { actionables }, stats: { actionablesComplete: true } }),
		{
			browserSessionId: "capacity-session",
			tabId: 7,
			observationId: "capacity-observation",
			capturedAt: Date.now(),
		},
	);
	assert.equal(registered.structure.actionables.length, REGISTERED_SCAN_REF_LIMITS.actionables);
	assert.equal(registered.stats.actionablesComplete, false);
	for (const item of registered.structure.actionables) {
		const ref = item.entityRefs?.domAction;
		assert.ok(ref);
		assert.equal(resolveRefUriDetailed(ref).ok, true);
	}
});
