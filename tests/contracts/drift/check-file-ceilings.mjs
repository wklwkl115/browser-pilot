import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const configPath = path.join(root, "tests", "contracts", "drift", "file-ceilings.json");
const proposeMode = process.argv.includes("--propose");

function lineCount(file) {
	return readFileSync(file, "utf8").split(/\r?\n/).length;
}

function check(config, base = root) {
	const failures = [];
	const proposals = [];
	const seen = new Set();
	for (const entry of config.files || []) {
		assert.equal(typeof entry.file, "string", "file ceiling entries need file");
		assert.equal(typeof entry.maxLines, "number", `${entry.file} needs numeric maxLines`);
		assert(!seen.has(entry.file), `duplicate file ceiling entry: ${entry.file}`);
		seen.add(entry.file);
		const absolute = path.join(base, entry.file);
		if (!existsSync(absolute)) {
			failures.push(`${entry.file}: missing file`);
			proposals.push({ file: entry.file, action: "remove missing entry", justification: "TODO: file was intentionally removed or moved" });
			continue;
		}
		const lines = lineCount(absolute);
		if (lines > entry.maxLines) {
			failures.push(`${entry.file}: ${lines}/${entry.maxLines} lines; split along documented seams or re-commit the ceiling in this diff with a one-line justification`);
			proposals.push({ file: entry.file, maxLines: Math.ceil(lines * 1.1), currentLines: lines, previousMaxLines: entry.maxLines, justification: "TODO: justify ceiling growth or split the file" });
		}
	}
	return { failures, proposals };
}

function selfTest() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-file-ceilings-"));
	try {
		writeFileSync(path.join(dir, "too-big.ts"), "a\nb\nc\n", "utf8");
		const { failures } = check({ schemaVersion: 1, files: [{ file: "too-big.ts", maxLines: 2 }] }, dir);
		assert(failures.length === 1 && failures[0].includes("split along documented seams"), "file ceiling self-test must fail over-ceiling files with remediation");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

selfTest();
const config = JSON.parse(readFileSync(configPath, "utf8"));
assert.equal(config.schemaVersion, 1, "file ceiling config schemaVersion must be 1");
const { failures, proposals } = check(config);
if (proposeMode) {
	if (!proposals.length) console.log("file-ceilings propose: no changes needed");
	else {
		console.log(`file-ceilings propose: update ${path.relative(root, configPath)} with these entries; include each justification in the diff:`);
		console.log(JSON.stringify(proposals, null, 2));
	}
	process.exit(0);
}
if (failures.length) throw new Error(`file ceiling contract failed:\n${failures.join("\n")}\nRun npm run check:file-ceilings -- --propose for a draft.`);
console.log(`file ceiling contract ok — ${config.files.length} files`);
