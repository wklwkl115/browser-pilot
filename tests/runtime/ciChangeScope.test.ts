import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { changedFiles, requiresFullValidation } = await import(
	new URL("../../scripts/ci-change-scope.mjs", import.meta.url).href
);

test("CI limits the lightweight route to known documentation paths", () => {
	assert.equal(
		requiresFullValidation([
			"AGENTS.md",
			"README.md",
			"README.zh-CN.md",
			"docs/reliability.md",
			"docs/assets/demo.gif",
		]),
		false,
	);
	for (const file of [
		"src/runtime.ts",
		"capture-src/capture.js",
		"src/kernels/abml/README.md",
		"tests/runtime/example.test.ts",
		"scripts/ci-change-scope.mjs",
		"package-lock.json",
		".github/workflows/ci.yml",
		".prettierrc.json",
		"bridge/browser_bridge_config.json",
		"docs/example.html",
		"docs/assets/example.js",
		"new-directory/file.txt",
	]) {
		assert.equal(requiresFullValidation(["README.md", file]), true, file);
	}
	assert.equal(requiresFullValidation(null), true);
	assert.equal(requiresFullValidation([]), true);
});

test("CI entry point checks changed Markdown, propagates failures, and supports PR and push events", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-ci-entry-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
	const commit = () => {
		git("add", "README.md");
		git("-c", "user.name=CI Test", "-c", "user.email=ci-test@example.invalid", "commit", "-qm", "fixture");
		return git("rev-parse", "HEAD");
	};
	const run = (event: object) => {
		const eventPath = path.join(cwd, "event.json");
		const outputPath = path.join(cwd, "output.txt");
		writeFileSync(eventPath, JSON.stringify(event));
		writeFileSync(outputPath, "");
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../../scripts/ci-change-scope.mjs", import.meta.url))],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
			},
		);
		return { ...result, output: readFileSync(outputPath, "utf8") };
	};
	try {
		git("init", "-q");
		writeFileSync(path.join(cwd, "README.md"), "# Initial\n");
		const base = commit();
		writeFileSync(path.join(cwd, "README.md"), "# Changed\n");
		commit();
		for (const event of [{ before: base }, { before: "f".repeat(40), pull_request: { base: { sha: base } } }]) {
			const result = run(event);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.output, "full=false\n");
		}
		writeFileSync(path.join(cwd, "README.md"), "# Changed\n\n-   unformatted\n");
		const invalid = run({ before: base });
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Formatting check failed: README.md/);
		rmSync(path.join(cwd, "README.md"));
		const deleted = run({ before: base });
		assert.equal(deleted.status, 0, deleted.stderr);
		assert.equal(deleted.output, "full=false\n");
		const unknown = run({ before: "f".repeat(40) });
		assert.equal(unknown.status, 0, unknown.stderr);
		assert.equal(unknown.output, "full=true\n");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("CI handles deleted docs, code renamed into docs, and unavailable bases", () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-ci-scope-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
	const commit = () => {
		git("add", "--all");
		git("-c", "user.name=CI Test", "-c", "user.email=ci-test@example.invalid", "commit", "-qm", "fixture");
		return git("rev-parse", "HEAD");
	};
	try {
		git("init", "-q");
		mkdirSync(path.join(cwd, "docs"));
		writeFileSync(path.join(cwd, "README.md"), "# Documentation\n");
		writeFileSync(path.join(cwd, "runtime.js"), "export const enabled = true;\n");
		const initial = commit();
		rmSync(path.join(cwd, "README.md"));
		const deleted = commit();
		assert.deepEqual(changedFiles(initial, cwd), ["README.md"]);
		assert.equal(requiresFullValidation(changedFiles(initial, cwd)), false);
		renameSync(path.join(cwd, "runtime.js"), path.join(cwd, "docs", "runtime.md"));
		commit();
		assert.deepEqual(changedFiles(deleted, cwd), ["docs/runtime.md", "runtime.js"]);
		assert.equal(requiresFullValidation(changedFiles(deleted, cwd)), true);
		for (const base of [undefined, "--help", "0".repeat(40), "f".repeat(40)]) {
			assert.equal(changedFiles(base, cwd), null);
			assert.equal(requiresFullValidation(changedFiles(base, cwd)), true);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
