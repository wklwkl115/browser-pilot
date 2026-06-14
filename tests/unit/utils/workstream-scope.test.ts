import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { matchesScope, parseCurrentActivation, summarizeWorkstreamScope } from "../../../scripts/workstream-scope.mjs";

test("workstream scope parser extracts top active Scope line", () => {
	const parsed = parseCurrentActivation(`# CURRENT

## 当前激活项

### Example work

Decision: ship.
Scope: scripts/**, tests/contracts/**, package.json

### Older active entry

Scope: docs/**

## 最近完成项
`);
	assert.equal(parsed.title, "Example work");
	assert.deepEqual(parsed.declared, ["scripts/**", "tests/contracts/**", "package.json"]);
});

test("workstream scope parser accepts wrapped markdown-code scope entries", () => {
	const parsed = parseCurrentActivation(`# CURRENT

## 当前激活项

### Example work

Decision: ship.
Scope: \`scripts/**\`, \`tests/contracts/**\`,
\`package.json\`

Boundary: stop here.
`);
	assert.equal(parsed.title, "Example work");
	assert.deepEqual(parsed.declared, ["scripts/**", "tests/contracts/**", "package.json"]);
});

test("workstream scope parser is inert without Scope line", () => {
	const parsed = parseCurrentActivation("## 当前激活项\n\n### Example\n\nDecision: none\n");
	assert.equal(parsed.title, "Example");
	assert.deepEqual(parsed.declared, []);
});

test("workstream scope matcher supports exact paths and /** globs", () => {
	assert.equal(matchesScope("scripts/check-dag.mjs", "scripts/**"), true);
	assert.equal(matchesScope("package.json", "package.json"), true);
	assert.equal(matchesScope("README.md", "docs/**"), false);
});

test("workstream scope summary is inert when public trees omit CURRENT.md", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-workstream-no-current-"));
	try {
		const summary = summarizeWorkstreamScope(root);
		assert.equal(summary.active, false);
		assert.deepEqual(summary.declared, []);
		assert.equal(summary.declaredRoot, "missing CURRENT.md");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("workstream scope ignores files that were already dirty at baseline", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-workstream-scope-"));
	const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	try {
		mkdirSync(path.join(root, "src"), { recursive: true });
		mkdirSync(path.join(root, "docs"), { recursive: true });
		mkdirSync(path.join(root, ".pi", "browser-artifacts"), { recursive: true });
		writeFileSync(path.join(root, "CURRENT.md"), `# CURRENT

## 当前激活项

### Scoped work

Scope: src/**
`, "utf8");
		writeFileSync(path.join(root, "src", "seed.ts"), "export const seed = 1;\n", "utf8");
		writeFileSync(path.join(root, "docs", "seed.md"), "seed\n", "utf8");
		git(["init", "-q"]);
		git(["config", "user.email", "test@example.invalid"]);
		git(["config", "user.name", "Test User"]);
		git(["add", "CURRENT.md", "src/seed.ts", "docs/seed.md"]);
		git(["commit", "-q", "-m", "seed"]);

		writeFileSync(path.join(root, "docs", "already-dirty.md"), "dirty before activation\n", "utf8");
		const baselinePath = path.join(root, ".pi", "browser-artifacts", "workstream-scope-baseline.json");
		writeFileSync(baselinePath, `${JSON.stringify({
			schemaVersion: 1,
			baselineCommit: "HEAD",
			baselineDirtyFiles: ["docs/already-dirty.md"],
			recordedAt: "2026-06-12T00:00:00.000Z",
		}, null, 2)}\n`, "utf8");
		writeFileSync(path.join(root, "src", "in-scope.ts"), "export const value = 2;\n", "utf8");
		writeFileSync(path.join(root, "docs", "new-out-of-scope.md"), "new drift\n", "utf8");

		const summary = summarizeWorkstreamScope(root, { baselinePath });
		assert.equal(summary.baselineStatus, "artifact");
		assert.deepEqual(summary.baselineDirtyFiles, ["docs/already-dirty.md"]);
		assert(summary.changedFiles.includes("docs/already-dirty.md"), "baseline dirty file should still be visible in changedFiles");
		assert(summary.changedFiles.includes("src/in-scope.ts"), "in-scope new file should be visible in changedFiles");
		assert.deepEqual(summary.outOfScope, ["docs/new-out-of-scope.md"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
