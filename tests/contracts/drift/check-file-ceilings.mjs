import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const configPath = path.join(root, "tests", "contracts", "drift", "file-ceilings.json");

function lineCount(file) {
	return readFileSync(file, "utf8").split(/\r?\n/).length;
}

function check(config, base = root) {
	const failures = [];
	const seen = new Set();
	for (const entry of config.files || []) {
		assert.equal(typeof entry.file, "string", "file ceiling entries need file");
		assert.equal(typeof entry.maxLines, "number", `${entry.file} needs numeric maxLines`);
		assert(!seen.has(entry.file), `duplicate file ceiling entry: ${entry.file}`);
		seen.add(entry.file);
		const absolute = path.join(base, entry.file);
		if (!existsSync(absolute)) {
			failures.push(`${entry.file}: missing file`);
			continue;
		}
		const lines = lineCount(absolute);
		if (lines > entry.maxLines) {
			failures.push(`${entry.file}: ${lines}/${entry.maxLines} lines; split along documented seams or re-commit the ceiling in this diff with a one-line justification`);
		}
	}
	return failures;
}

function selfTest() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-file-ceilings-"));
	try {
		writeFileSync(path.join(dir, "too-big.ts"), "a\nb\nc\n", "utf8");
		const failures = check({ schemaVersion: 1, files: [{ file: "too-big.ts", maxLines: 2 }] }, dir);
		assert(failures.length === 1 && failures[0].includes("split along documented seams"), "file ceiling self-test must fail over-ceiling files with remediation");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

selfTest();
const config = JSON.parse(readFileSync(configPath, "utf8"));
assert.equal(config.schemaVersion, 1, "file ceiling config schemaVersion must be 1");
const failures = check(config);
if (failures.length) throw new Error(`file ceiling contract failed:\n${failures.join("\n")}`);
console.log(`file ceiling contract ok — ${config.files.length} files`);
