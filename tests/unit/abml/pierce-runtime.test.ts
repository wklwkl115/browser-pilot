import test from "node:test";
import assert from "node:assert/strict";
import { pierceRefEntities } from "../../../src/abml/verbs/pierceRuntime.ts";
import { clearResourceStore } from "../../../mcp/resourceStore.ts";

function makeServer() {
	return {
		async sendCommand(command: Record<string, unknown>) {
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Accessibility.getFullAXTree") {
				return {
					id: "ax-tree",
					acknowledged: true,
					tabId: 7,
					data: { result: { nodes: [
						{ nodeId: "ax-shadow", backendDOMNodeId: 91, role: { value: "button" }, name: { value: "Shadow pay" } },
						{ nodeId: "ax-far", backendDOMNodeId: 92, role: { value: "button" }, name: { value: "Far away" } },
					] } },
				};
			}
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "DOM.getBoxModel") {
				const id = Number(command.params?.backendNodeId);
				if (id === 91) return { id: "box-shadow", acknowledged: true, tabId: 7, data: { result: { border: [100, 180, 180, 180, 180, 220, 100, 220] } } };
				if (id === 92) return { id: "box-far", acknowledged: true, tabId: 7, data: { result: { border: [500, 500, 580, 500, 580, 540, 500, 540] } } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
}

test("abml pierce runtime returns nearby AX entities for closed-shadow targets", async () => {
	clearResourceStore();
	const pierced = await pierceRefEntities(makeServer() as any, {
		refId: "pi-ref://control/pay",
		kind: "control",
		locators: [{ by: "css", value: "#host" }],
		owner: { tabId: 7 },
		policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
		geometry: { point: { x: 140, y: 200 } },
		observationId: "obs-pierce",
		createdAt: Date.now(),
		ttlMs: 60_000,
	} as any, { tabId: 7, observationId: "obs-pierce", timeoutMs: 5_000 });
	assert.equal(pierced.ok, true);
	if (!pierced.ok) return;
	assert.equal(pierced.entities.length, 1);
	assert.equal(pierced.entities[0]?.name, "Shadow pay");
	assert.equal(pierced.entities[0]?.source, "ax");
	assert.equal(pierced.data.transport, "cdp-ax");
});
