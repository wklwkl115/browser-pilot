import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const governancePath = path.join(root, "REPO_GOVERNANCE.md");
const abmlReadmePath = path.join(root, "src/kernels/abml/README.md");
const commandSharedPath = path.join(root, "src/commands/commandShared.ts");

function text(filePath: string) {
	return readFileSync(filePath, "utf8");
}

test("repo governance uses mise-first gate commands", () => {
	const governance = text(governancePath);
	assert.match(governance, /mise run verify/);
	assert.doesNotMatch(governance, /npm run /);
});

test("repo governance documents one explicit child-agent workflow", () => {
	const governance = text(governancePath);
	assert.match(governance, /^## Child-Agent Workflow$/m);
	for (const agent of ["scout", "planner", "worker", "reviewer"]) {
		assert.match(governance, new RegExp(`\\b${agent}\\b`));
	}
});

test("repo governance exposes the canonical local gate sequence", () => {
	const governance = text(governancePath);
	assert.match(governance, /mise run dev/);
	assert.match(governance, /mise run affected/);
	assert.match(governance, /mise run verify/);
});

test("abml readme uses canonical mise validation guidance", () => {
	const readme = text(abmlReadmePath);
	assert.doesNotMatch(readme, /npm run /);
	assert.match(readme, /mise run verify/);
});

test("commandShared explains parameter classes without numbered doctrine labels", () => {
	const source = text(commandSharedPath);
	assert.doesNotMatch(source, /Charter law|铁律/);
	assert.match(source, /intent/i);
	assert.match(source, /mechanical/i);
});
