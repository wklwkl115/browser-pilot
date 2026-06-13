import test from "node:test";
import assert from "node:assert/strict";
import { actionabilityFailure, verificationFailure } from "../../../src/abml/verbs/router.ts";
import { runAbmlRead } from "../../../src/abml/verbs/read.ts";
import { runAbmlPierce } from "../../../src/abml/verbs/pierce.ts";
import { runAbmlFrame } from "../../../src/abml/verbs/frame.ts";

test("abml verbs read returns entities through resolver", async () => {
	const result = await runAbmlRead({ plane: "structure", depth: 1 }, async () => ({ entities: [{ ref: "pi-ref://control/x", kind: "control", role: "button", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" }] }));
	assert.equal(result.ok, true);
	assert.equal(result.verb, "read");
	assert.equal(result.entities?.length, 1);
});

test("abml verbs helper constructors expose consistent failure envelopes", () => {
	const blocked = actionabilityFailure("click", { ok: false, spec: { timeoutMs: 5000, pollMs: 100, stableWindowMs: 150, stableEpsilonPx: 1, required: [] }, elapsedMs: 1, attempts: 1, checks: {}, blockers: [{ code: "disabled", message: "disabled" }] });
	assert.equal(blocked.error.code, "TARGET_DISABLED");
	const verify = verificationFailure("click", { status: "failed", verb: "click", observed: { clicked: false }, evidence: [{ kind: "dom", summary: "no state change" }], elapsedMs: 1 });
	assert.equal(verify.error.code, "VERIFY_FAILED");
});

test("abml verbs pierce/frame wrappers return successful metadata", async () => {
	const pierced = await runAbmlPierce({ ref: "pi-ref://control/x", depth: 2 }, async () => ({ entities: [{ ref: "pi-ref://control/y", kind: "control", role: "button", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "ax" }] }));
	assert.equal(pierced.ok, true);
	assert.equal(pierced.meta?.depth, 2);
	const framed = await runAbmlFrame({ depth: 3 }, async () => ({ data: { frameCount: 2 } }));
	assert.equal(framed.ok, true);
	assert.equal(framed.meta?.depth, 3);
});
