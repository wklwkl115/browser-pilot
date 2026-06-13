import test from "node:test";
import assert from "node:assert/strict";
import { clearResourceStore, registerRefDescriptor } from "../../../src/resources/resourceStore.ts";
import { prepareExecuteStdlib } from "../../../src/tools/executeStdlib.ts";

function registerElementRef(refId = "pi-ref://element/stdlib-test"): string {
	return registerRefDescriptor({
		descriptor: {
			refId,
			kind: "element",
			locators: [{ by: "backendNodeId", value: 91 }, { by: "css", value: "#submit" }],
			owner: { browserSessionId: "session-1", tabId: 7 },
			policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
			geometry: { point: { x: 120, y: 240 } },
			observationId: "obs-1",
			createdAt: Date.now(),
			ttlMs: 60_000,
		},
		browserSessionId: "session-1",
	});
}

test("execute stdlib stays out of ordinary scripts", () => {
	const prepared = prepareExecuteStdlib("return document.title");
	assert.equal(prepared.script, "return document.title");
	assert.equal(prepared.stdlib, undefined);
});

test("execute stdlib embeds referenced pi refs", () => {
	clearResourceStore();
	const ref = registerElementRef();
	const prepared = prepareExecuteStdlib(`return pi.box("${ref}")`);
	assert.equal(prepared.stdlib?.used, true);
	assert.equal(prepared.stdlib?.refsEmbedded, 1);
	assert.deepEqual(prepared.stdlib?.resolveMisses, []);
	assert.ok(prepared.script.includes("const pi ="));
	assert.ok(prepared.script.includes('"by":"css"'));
	assert.ok(prepared.script.includes("#submit"));
});

test("execute stdlib records unresolved ref misses without hiding them", () => {
	clearResourceStore();
	const ref = "pi-ref://element/not-registered";
	const prepared = prepareExecuteStdlib(`return pi.resolve("${ref}")`);
	assert.equal(prepared.stdlib?.used, true);
	assert.equal(prepared.stdlib?.refsEmbedded, 0);
	assert.deepEqual(prepared.stdlib?.resolveMisses, [ref]);
	assert.ok(prepared.script.includes("HANDLE_NOT_FOUND"));
});

test("execute stdlib namespace is unchanged when pi.click is not referenced", () => {
	clearResourceStore();
	const prepared = prepareExecuteStdlib("return pi.resolve(window.__targetRef)");
	assert.deepEqual(prepared.stdlib?.namespace, ["resolve", "box", "setValue", "settled"]);
	assert.ok(prepared.script.includes("Object.freeze({ resolve, box, setValue, settled"));
	assert.equal(/\bclick\s*[:(]/.test(prepared.script), false);
	assert.equal(prepared.script.includes("__PI_BROWSER_STDLIB_CLICK_BINDING__"), false);
	assert.equal(prepared.script.includes("__piBrowserStdlibResolve"), false);
});

test("execute stdlib exposes pi.click only when referenced and sends safe target facts", () => {
	clearResourceStore();
	const ref = registerElementRef();
	const prepared = prepareExecuteStdlib(`return await pi.click("${ref}")`);
	assert.deepEqual(prepared.stdlib?.namespace, ["resolve", "box", "setValue", "settled", "click"]);
	assert.ok(prepared.script.includes("Object.freeze({ resolve, box, setValue, settled, click"));
	assert.ok(prepared.script.includes("__PI_BROWSER_STDLIB_CLICK_BINDING__"));
	assert.ok(prepared.script.includes("__piBrowserStdlibResolve"));
	assert.ok(prepared.script.includes("__safeTarget"));
	assert.ok(prepared.script.includes('"by":"backendNodeId"'));
	assert.equal(prepared.stdlib?.targetRefs?.[0]?.backendNodeId, 91);
	assert.deepEqual(prepared.stdlib?.targetRefs?.[0]?.point, { x: 120, y: 240 });
});

test("execute stdlib disabled mode keeps pi.click absent", () => {
	clearResourceStore();
	const ref = registerElementRef();
	const prepared = prepareExecuteStdlib(`return await pi.click("${ref}")`, { enabled: false });
	assert.equal(prepared.script, `return await pi.click("${ref}")`);
	assert.equal(prepared.stdlib, undefined);
});
