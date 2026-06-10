import assert from "node:assert/strict";
import { getDefinedDistillerToolNames, getDistillerDefinition, getDistillerRegistrySnapshot, hasRegisteredDistiller } from "../../../src/tools/distillerRegistry.ts";

const snapshot = getDistillerRegistrySnapshot();
assert(snapshot.toolNames.includes("browser_evidence"), "distiller coverage: browser_evidence fallback distiller must be registered");
assert(snapshot.toolNames.includes("browser_network"), "distiller coverage: browser_network fallback distiller must be registered");
assert(snapshot.toolNames.includes("browser_hook"), "distiller coverage: browser_hook fallback distiller must be registered");
assert(snapshot.commandRuleLabels.includes("evidence.collect"), "distiller coverage: evidence.collect fallback rule must be registered");
assert(snapshot.commandRuleLabels.includes("network.*"), "distiller coverage: network.* fallback rule must be registered");
assert(snapshot.commandRuleLabels.includes("hook.dom-flow"), "distiller coverage: hook.dom-flow fallback rule must be registered");
assert(snapshot.commandRuleLabels.includes("ws.*"), "distiller coverage: ws.* fallback rule must be registered");

for (const [toolName, command] of [
	["browser_evidence", "evidence.collect"],
	["browser_network", "network.list"],
	["browser_hook", "hook.getNodeListeners"],
	["browser_hook", "hook.getListenerChain"],
	["browser_hook", "hook.getSinkHints"],
	["browser_command", "ws.collect"],
]) {
	assert.equal(hasRegisteredDistiller(toolName, command), true, `distiller coverage: expected registered fallback for ${toolName}:${command}`);
}

for (const [toolName, command] of [
	["browser_command", "cdp"],
	["browser_execute", "javascript"],
	["browser_artifact", "json"],
]) {
	assert.equal(hasRegisteredDistiller(toolName, command), false, `distiller coverage: unexpected fallback distiller for ${toolName}:${command}`);
}

for (const toolName of getDefinedDistillerToolNames()) {
	const definition = getDistillerDefinition(toolName);
	assert.equal(typeof definition?.factify, "function", `distiller coverage: ${toolName} DistillerDefinition must provide factify`);
	const facts = definition.factify({ ok: true, data: {} }, `${toolName}.coverage`);
	assert(Array.isArray(facts), `distiller coverage: ${toolName} factify must return an array`);
	for (const fact of facts) {
		assert.equal(typeof fact.ref, "string", `distiller coverage: ${toolName} fact.ref must be string`);
		assert.equal(typeof fact.plane, "string", `distiller coverage: ${toolName} fact.plane must be string`);
		assert(fact.renderings && typeof fact.renderings === "object", `distiller coverage: ${toolName} fact.renderings must exist`);
	}
}

console.log("distiller coverage ok");
