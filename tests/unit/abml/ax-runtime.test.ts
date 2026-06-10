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
	const { entities } = await readAxEntities(server as any, { tabId: 7, observationId: "snap-1", url: "https://example.test/canvas", timeoutMs: 5_000 });
	assert.equal(entities.length, 2);
	assert.equal(entities[0]?.entity.role, "button");
	assert.equal(entities[0]?.entity.geometry?.point?.x, 120);
	assert.equal(entities[1]?.entity.kind, "text");
	assert.equal(server.calls.filter((call) => call.cdpMethod === "DOM.getBoxModel").length, 2);
});

function makeAxTreeServer(nodes: Array<Record<string, unknown>>) {
	return {
		async sendCommand(command: Record<string, unknown>) {
			if (command.cdpMethod === "Accessibility.getFullAXTree") return { id: "ax", acknowledged: true, tabId: 1, data: { result: { nodes } } };
			if (command.cdpMethod === "DOM.getBoxModel") return { id: "box", acknowledged: true, tabId: 1, data: { result: {} } };
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
}

test("ax runtime derives table relations (cellOf/rowOf/columnOf/headerFor) + cell row/col structure", async () => {
	const server = makeAxTreeServer([
		{ nodeId: "t", backendDOMNodeId: 1, role: { value: "table" }, name: { value: "People" }, childIds: ["r1", "r2"] },
		{ nodeId: "r1", backendDOMNodeId: 10, role: { value: "row" }, childIds: ["h1", "h2"] },
		{ nodeId: "h1", backendDOMNodeId: 11, role: { value: "columnheader" }, name: { value: "Name" } },
		{ nodeId: "h2", backendDOMNodeId: 12, role: { value: "columnheader" }, name: { value: "Age" } },
		{ nodeId: "r2", backendDOMNodeId: 20, role: { value: "row" }, childIds: ["c1", "c2"] },
		{ nodeId: "c1", backendDOMNodeId: 21, role: { value: "cell" }, name: { value: "Alice" } },
		{ nodeId: "c2", backendDOMNodeId: 22, role: { value: "cell" }, name: { value: "30" } },
	]);
	const { entities, anchors } = await readAxEntities(server as any, { tabId: 1, observationId: "snap", url: "https://example.test/table", timeoutMs: 5_000 });
	const of = (sourceKey: string, type: string) => anchors.filter((a) => a.sourceKey === sourceKey && a.type === type).map((a) => a.targetKey);
	assert.deepEqual(of("b:21", "cellOf"), ["b:1"], "data cell -> table");
	assert.deepEqual(of("b:21", "rowOf"), ["b:20"], "data cell -> its row");
	assert.deepEqual(of("b:21", "columnOf"), ["b:11"], "data cell -> its column's header (col 1 = Name)");
	assert.deepEqual(of("b:22", "columnOf"), ["b:12"], "second data cell -> Age header");
	assert.deepEqual(of("b:11", "headerFor"), ["b:1"], "column header -> table");
	const aliceCell = entities.find((e) => e.entity.hints?.backendNodeId === 21);
	assert.deepEqual(aliceCell?.entity.structure, { colIndex: 1, rowIndex: 2 }, "row/col context rides on the cell entity structure");
});

test("ax runtime stashes the nearest nav/list container key for DOM-sourced currentIn", async () => {
	// Chrome's getFullAXTree omits aria-current, so readAxEntities does NOT emit currentIn directly.
	// It stashes hints.currentContainerKey; deriveStateRelationAnchors turns it into currentIn once the
	// DOM scan supplies state.current (validated in relations.test.ts + the live smoke).
	const server = makeAxTreeServer([
		{ nodeId: "nav", backendDOMNodeId: 100, role: { value: "navigation" }, name: { value: "Breadcrumb" }, childIds: ["l1", "l2"] },
		{ nodeId: "l1", backendDOMNodeId: 101, role: { value: "link" }, name: { value: "Home" } },
		{ nodeId: "l2", backendDOMNodeId: 102, role: { value: "link" }, name: { value: "Products" } },
	]);
	const { entities, anchors } = await readAxEntities(server as any, { tabId: 1, observationId: "snap", url: "https://example.test/nav", timeoutMs: 5_000 });
	assert.equal(anchors.filter((a) => a.type === "currentIn").length, 0, "currentIn is not emitted from AX (aria-current absent)");
	const products = entities.find((e) => e.entity.hints?.backendNodeId === 102);
	assert.deepEqual(products?.entity.hints?.currentContainerKeys, ["b:100"], "built nav container chain stashed for currentIn derivation");
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

test("readAxEntities caches raw AX tree and box model by explicit cache key", async () => {
	let treeCalls = 0;
	let boxCalls = 0;
	const server = {
		async sendCommand(command: Record<string, any>) {
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "Accessibility.getFullAXTree") {
				treeCalls += 1;
				return {
					id: "ax-tree",
					acknowledged: true,
					tabId: 7,
					data: { result: { nodes: [{ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } }] } },
				};
			}
			if (command.cmd === "persistent_cdp" && command.cdpMethod === "DOM.getBoxModel") {
				boxCalls += 1;
				return { id: "box-1", acknowledged: true, tabId: 7, data: { result: { border: [140, 240, 220, 240, 220, 272, 140, 272] } } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
	const first = await readAxEntities(server as any, { tabId: 7, observationId: "obs-1", url: "https://example.test", timeoutMs: 5_000, cacheKey: "fp-1" });
	const second = await readAxEntities(server as any, { tabId: 7, observationId: "obs-2", url: "https://example.test", timeoutMs: 5_000, cacheKey: "fp-1" });
	assert.equal(treeCalls, 1);
	assert.equal(boxCalls, 1);
	assert.equal(first.entities.length, 1);
	assert.equal(second.entities.length, 1);
	assert.notEqual(first.entities[0]?.entity, second.entities[0]?.entity, "cached raw AX data must still rebuild entity objects per call");
	assert.equal(second.entities[0]?.entity.name, "Pay now");
	assert.deepEqual(second.entities[0]?.entity.geometry?.point, { x: 180, y: 256 });
});
