import test from "node:test";
import assert from "node:assert/strict";
import { mergeAxIntoDomEntities, readAxEntities } from "../../../src/abml/verbs/axRuntime.ts";

function makeServer() {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		async sendCommand(command: Record<string, unknown>) {
			calls.push(command);
			if (command.cdpMethod === "Accessibility.getFullAXTree") {
				return {
					id: "ax-tree",
					acknowledged: true,
					tabId: 7,
					data: {
						result: {
							nodes: [
								{ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } },
								{ nodeId: "ax-2", backendDOMNodeId: 82, role: { value: "StaticText" }, name: { value: "Canvas label" } },
							],
						},
					},
				};
			}
			if (command.cdpMethod === "DOM.getBoxModel") {
				const backendNodeId = Number(command.params?.backendNodeId);
				if (backendNodeId === 81) return { id: "box-1", acknowledged: true, tabId: 7, data: { result: { border: [80, 180, 160, 180, 160, 212, 80, 212] } } };
				if (backendNodeId === 82) return { id: "box-2", acknowledged: true, tabId: 7, data: { result: { border: [20, 40, 180, 40, 180, 80, 20, 80] } } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
}

test("abml ax runtime reads AX tree and box model through persistent CDP", async () => {
	const server = makeServer();
	const entities = await readAxEntities(server as any, { tabId: 7, observationId: "snap-1", url: "https://example.test/canvas", timeoutMs: 5_000 });
	assert.equal(entities.length, 2);
	assert.equal(entities[0]?.entity.role, "button");
	assert.equal(entities[0]?.entity.geometry?.point?.x, 120);
	assert.equal(entities[1]?.entity.kind, "text");
	assert.equal(server.calls.filter((call) => call.cdpMethod === "DOM.getBoxModel").length, 2);
});

test("abml ax runtime appends unmatched AX entities and merges matching controls", () => {
	const dom = [{
		ref: "pi-ref://control/dom-pay",
		kind: "control",
		role: "button",
		name: "Pay now",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom",
		locators: [{ by: "css", value: "#pay" }],
		geometry: { point: { x: 120, y: 196 } },
		hints: { selector: "#pay" },
	}];
	const axBuilt = [
		{
			entity: {
				kind: "control",
				role: "button",
				name: "Pay now",
				state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
				source: "ax",
				locators: [{ by: "axNodeId", value: "ax-1" }],
				geometry: { point: { x: 121, y: 195 } },
				hints: { axNodeId: "ax-1", backendNodeId: 81 },
			},
			descriptor: { kind: "control", locators: [{ by: "axNodeId", value: "ax-1" }], owner: {}, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true }, observationId: "obs", createdAt: Date.now(), ttlMs: 60_000 },
		},
		{
			entity: {
				kind: "text",
				role: "StaticText",
				name: "Canvas label",
				state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
				source: "ax",
				locators: [{ by: "axNodeId", value: "ax-2" }],
				geometry: { point: { x: 100, y: 60 } },
				hints: { axNodeId: "ax-2", backendNodeId: 82 },
			},
			descriptor: { kind: "text", locators: [{ by: "axNodeId", value: "ax-2" }], owner: {}, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false }, observationId: "obs", createdAt: Date.now(), ttlMs: 60_000 },
		},
	] as any;
	const merged = mergeAxIntoDomEntities(dom as any, axBuilt);
	assert.equal(merged.length, 2);
	assert.equal(merged[0]?.locators?.some((locator) => locator.by === "axNodeId"), true);
	assert.deepEqual(merged[0]?.hints?.mergedSources, ["dom", "ax"]);
	assert.equal(merged[1]?.source, "ax");
	assert.match(String(merged[1]?.ref || ""), /^pi-ref:\/\//);
});
