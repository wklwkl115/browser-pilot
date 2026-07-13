import assert from "node:assert/strict";
import test from "node:test";
import { agentError } from "../../src/commands/agent/agentErrors.js";
import { compactError } from "../../src/utils/errors.js";

test("agentError surfaces stable agent codes at top-level envelope code", () => {
	const err = agentError("CONTEXT_EXPIRED", "context gone");
	assert.equal(err.code, "CONTEXT_EXPIRED");
	const plain = compactError(err);
	assert.equal(plain.code, "CONTEXT_EXPIRED");
	assert.equal((plain.details as { agentCode?: string }).agentCode, "CONTEXT_EXPIRED");
	assert.equal((plain.details as { agentFacade?: boolean }).agentFacade, true);
	assert.equal((plain.taxonomy as { category?: string }).category, "tool.agent_facade");
});
