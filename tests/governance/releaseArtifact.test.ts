import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const script = path.join(root, "scripts", "verify-release-artifact.mjs");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name: string; version: string };
const filename = `${pkg.name}-${pkg.version}.tgz`;

function runVerifier(directory: string, tag = `v${pkg.version}`, output?: string) {
	return spawnSync(process.execPath, [script, "--artifact-dir", directory, ...(output ? ["--github-output", output] : [])], {
		cwd: root,
		env: { ...process.env, GITHUB_REF_NAME: tag },
		encoding: "utf8",
	});
}

function writeArtifact(directory: string, sha256?: string) {
	const tarball = path.join(directory, filename);
	const bytes = Buffer.from("verified release tarball fixture", "utf8");
	writeFileSync(tarball, bytes);
	writeFileSync(path.join(directory, `${filename}.sha256.json`), `${JSON.stringify({
		schema: "browser-pilot-package-smoke/v1",
		name: pkg.name,
		version: pkg.version,
		filename,
		sha256: sha256 ?? createHash("sha256").update(bytes).digest("hex"),
		compressedSize: bytes.length,
		unpackedSize: bytes.length,
		fileCount: 1,
	})}\n`);
}

test("release artifact verifier accepts only the exact tag, singleton tarball, identity, size, and SHA-256", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "browser-pilot-release-artifact-test-"));
	try {
		writeArtifact(directory);
		const githubOutput = path.join(directory, "github-output.txt");
		const valid = runVerifier(directory, `v${pkg.version}`, githubOutput);
		assert.equal(valid.status, 0, valid.stderr);
		const parsed = JSON.parse(valid.stdout) as { version: string; sha256: string; tarball: string };
		assert.equal(parsed.version, pkg.version);
		assert.equal(parsed.tarball, path.join(directory, filename));
		assert.match(readFileSync(githubOutput, "utf8"), new RegExp(`tarball=.*${filename.replaceAll(".", "\\.")}`));

		const wrongTag = runVerifier(directory, "v999.0.0");
		assert.notEqual(wrongTag.status, 0);
		assert.match(wrongTag.stderr, /release tag mismatch/);

		writeArtifact(directory, "0".repeat(64));
		const wrongHash = runVerifier(directory);
		assert.notEqual(wrongHash.status, 0);
		assert.match(wrongHash.stderr, /release SHA-256 mismatch/);

		writeFileSync(path.join(directory, "duplicate.tgz"), "duplicate");
		const duplicate = runVerifier(directory);
		assert.notEqual(duplicate.status, 0);
		assert.match(duplicate.stderr, /exactly one tarball/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
