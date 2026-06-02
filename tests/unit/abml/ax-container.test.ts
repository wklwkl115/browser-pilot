// ABML P3 (relationship arm) — container membership. Walking the AX childIds graph upward
// gives each member its nearest owning container (radio↔radiogroup, item↔list, cell↔row↔
// table), surfaced as hints.containerRole/containerName on the entity.
import test from "node:test";
import assert from "node:assert/strict";
import { nearestContainer } from "../../../src/abml/verbs/axRuntime.ts";

function node(nodeId: string, role: string, name: string, childIds: string[] = []): Record<string, unknown> {
	return { nodeId, role: { value: role }, name: { value: name }, childIds };
}

test("nearestContainer walks up to the owning container with its name", () => {
	const radiogroup = node("1", "radiogroup", "Crust", ["2", "3"]);
	const radioA = node("2", "radio", "Deep dish");
	const parentByChildId = new Map<string, Record<string, unknown>>([["2", radiogroup], ["3", radiogroup]]);
	const container = nearestContainer(radioA, parentByChildId);
	assert.equal(container?.role, "radiogroup");
	assert.equal(container?.name, "Crust");
});

test("nearestContainer returns the closest container role (cell→row, row→table)", () => {
	const table = node("10", "table", "Results", ["11"]);
	const row = node("11", "row", "", ["12"]);
	const cell = node("12", "cell", "42");
	const parentByChildId = new Map<string, Record<string, unknown>>([["11", table], ["12", row]]);
	assert.equal(nearestContainer(cell, parentByChildId)?.role, "row");
	assert.equal(nearestContainer(row, parentByChildId)?.role, "table");
});

test("nearestContainer climbs through a non-container wrapper", () => {
	const radiogroup = node("1", "radiogroup", "Crust", ["wrap"]);
	const wrap = node("wrap", "generic", "", ["2"]);
	const radio = node("2", "radio", "Deep dish");
	const parentByChildId = new Map<string, Record<string, unknown>>([["wrap", radiogroup], ["2", wrap]]);
	assert.equal(nearestContainer(radio, parentByChildId)?.role, "radiogroup");
});

test("nearestContainer returns undefined when no container ancestor exists", () => {
	const main = node("20", "main", "", ["21"]);
	const button = node("21", "button", "Go");
	const parentByChildId = new Map<string, Record<string, unknown>>([["21", main]]);
	assert.equal(nearestContainer(button, parentByChildId), undefined);
});
