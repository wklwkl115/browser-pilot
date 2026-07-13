import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_FACADE_TOOL_NAMES, toolsForProfile } from "../../src/commands/capabilityProfileCatalog.js";
import { collectCommandDefs, collectAgentFacadeDefs } from "../../src/apps/cli/registry.js";
import { SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY } from "../../src/commands/operationResolvers.js";
import { AGENT_PUBLISHED_WRITE_KINDS } from "../../src/kernels/agent/agentTypes.js";
import { SEMANTIC_COMPLETION_RESOLVER_IDS } from "../../src/kernels/agent/semanticAction.js";
import { mayAutoReplayMutation } from "../../src/kernels/agent/recoveryPolicy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("public catalog includes agent façade at toolCount 22", () => {
	assert.equal(collectCommandDefs().length, 22);
	assert.equal(collectAgentFacadeDefs().length, 3);
	assert.deepEqual(
		collectAgentFacadeDefs().map((d) => d.name).sort(),
		[...AGENT_FACADE_TOOL_NAMES].sort(),
	);
	for (const name of AGENT_FACADE_TOOL_NAMES) {
		assert.ok(collectCommandDefs().some((d) => d.name === name));
	}
});

test("agent profile excludes security and evaluate surface", () => {
	const agent = new Set(toolsForProfile("agent"));
	assert.equal(agent.size, 3);
	assert.equal(agent.has("browser_execute"), false);
	assert.equal(agent.has("browser_sqli"), false);
	assert.deepEqual([...toolsForProfile("agent-preview")].sort(), [...toolsForProfile("agent")].sort());
});

test("semantic write kinds have exact resolvers", () => {
	for (const kind of AGENT_PUBLISHED_WRITE_KINDS) {
		assert.ok(SEMANTIC_COMPLETION_RESOLVER_IDS[kind] in SEMANTIC_ACTION_COMPLETION_RESOLVER_REGISTRY);
	}
});

test("mutation replay after ACK is forbidden", () => {
	assert.equal(mayAutoReplayMutation("acked"), false);
	assert.equal(mayAutoReplayMutation("terminal"), false);
});

test("governance docs document façade root exception and archive design", () => {
	const governance = readFileSync(path.join(root, "REPO_GOVERNANCE.md"), "utf8");
	const wiki = readFileSync(path.join(root, "CODE_WIKI.md"), "utf8");
	assert.match(governance, /browser-agent-turn\/v1/);
	assert.match(governance, /Agent Interaction Plane/);
	assert.match(wiki, /Agent Interaction Plane/);
	assert.match(wiki, /Agent Interaction Plane/);
	assert.match(wiki, /toolCount.*22|22.*tools|browser_view/);
	assert.match(governance, /toolCount.*22|22 canonical|22 tools/);
	const archived = readFileSync(path.join(root, "docs/archive/agent-interaction-plane.md"), "utf8");
	assert.match(archived, /已归档|Archived/i);
	// Root design draft must not remain as a second authority.
	let rootDraftMissing = false;
	try {
		readFileSync(path.join(root, "方案.md"), "utf8");
	} catch {
		rootDraftMissing = true;
	}
	assert.equal(rootDraftMissing, true);
});
