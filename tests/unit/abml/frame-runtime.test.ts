import test from "node:test";
import assert from "node:assert/strict";
import { readFrameEntities, probeFrameReachability, frameIdFromRef } from "../../../src/abml/verbs/frameRuntime.ts";
import { clearResourceStore } from "../../../src/resources/resourceStore.ts";
import type { RefDescriptor } from "../../../src/abml/types.ts";

function makeServer(crossOriginBlocked = false) {
	return {
		async sendCommand(command: Record<string, unknown>) {
			if (command.cmd === "frame.list") {
				return {
					id: "frame-list",
					acknowledged: true,
					tabId: 7,
					data: {
						frameTree: { frameId: "root" },
						frames: [
							{ frameId: "root", id: "root", url: "https://example.test", name: "root", securityOrigin: "https://example.test" },
							{ frameId: "child-x", id: "child-x", url: "https://cross.example.test", name: "child", securityOrigin: "https://cross.example.test", parentId: "root" },
						],
					},
				};
			}
			if (command.cmd === "frame.evaluate") {
				if (crossOriginBlocked) return { id: "frame-eval", acknowledged: true, tabId: 7, data: { ok: false, error_code: "FRAME_EVAL_FAILED", error: "cross-origin frame unreachable" } };
				return { id: "frame-eval", acknowledged: true, tabId: 7, data: { result: { value: { href: "https://cross.example.test", title: "child" } } } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
}

test("abml frame runtime maps frame.list into frame entities", async () => {
	clearResourceStore();
	const result = await readFrameEntities(makeServer() as any, { browserSessionId: "default", tabId: 7, observationId: "obs-frame", depth: 2 });
	assert.equal(result.entities.length, 2);
	assert.equal(result.entities[1]?.kind, "frame");
	assert.equal(result.entities[1]?.hints?.frameId, "child-x");
	assert.match(String(result.entities[1]?.ref || ""), /^pi-ref:\/\/frame\//);
});

test("abml frame runtime maps unreachable frame evaluation to CROSS_ORIGIN_BLOCKED", async () => {
	const blocked = await probeFrameReachability(makeServer(true) as any, { browserSessionId: "default", tabId: 7, frameId: "child-x", timeoutMs: 5_000 });
	assert.equal(blocked.ok, false);
	if (blocked.ok) return;
	assert.equal(blocked.error.code, "CROSS_ORIGIN_BLOCKED");
});

test("abml frame runtime returns evaluated payload when the frame is reachable", async () => {
	const reachable = await probeFrameReachability(makeServer(false) as any, { browserSessionId: "default", tabId: 7, frameId: "child-x", timeoutMs: 5_000 });
	assert.equal(reachable.ok, true);
	if (!reachable.ok) return;
	assert.equal(reachable.data.href, "https://cross.example.test");
	assert.equal(reachable.data.title, "child");
});

test("abml frameIdFromRef prefers the attrSignature frameId then falls back to semantic value", () => {
	const withLocator = {
		refId: "pi-ref://frame/a",
		locators: [{ by: "attrSignature", value: { frameId: "child-x", url: "https://cross.example.test" } }],
		semantic: { role: "frame", name: "child", value: "semantic-fallback" },
	} as unknown as RefDescriptor;
	assert.equal(frameIdFromRef(withLocator), "child-x");

	const semanticOnly = {
		refId: "pi-ref://frame/b",
		locators: [{ by: "css", value: "#frame" }],
		semantic: { role: "frame", name: "child", value: "semantic-fallback" },
	} as unknown as RefDescriptor;
	assert.equal(frameIdFromRef(semanticOnly), "semantic-fallback");

	const blankFrameId = {
		refId: "pi-ref://frame/c",
		locators: [{ by: "attrSignature", value: { frameId: "   " } }],
		semantic: { role: "frame", name: "child", value: "semantic-fallback" },
	} as unknown as RefDescriptor;
	assert.equal(frameIdFromRef(blankFrameId), "semantic-fallback", "whitespace-only frameId must not win over the semantic value");
});
