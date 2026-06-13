import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const configPath = path.join(root, "tests", "contracts", "drift", "file-ceilings.json");
const proposeMode = process.argv.includes("--propose");

function readFileStats(file) {
	const buf = readFileSync(file);
	return { lines: buf.toString("utf8").split(/\r?\n/).length, bytes: buf.length };
}

function check(config, base = root) {
	const failures = [];
	const proposals = [];
	const seen = new Set();
	for (const entry of config.files || []) {
		assert.equal(typeof entry.file, "string", "file ceiling entries need file");
		const hasLines = typeof entry.maxLines === "number";
		const hasBytes = typeof entry.maxBytes === "number";
		assert(hasLines || hasBytes, `${entry.file} needs a numeric maxLines and/or maxBytes`);
		assert(!seen.has(entry.file), `duplicate file ceiling entry: ${entry.file}`);
		seen.add(entry.file);
		const absolute = path.join(base, entry.file);
		if (!existsSync(absolute)) {
			failures.push(`${entry.file}: missing file`);
			proposals.push({ file: entry.file, action: "remove missing entry", justification: "TODO: file was intentionally removed or moved" });
			continue;
		}
		const { lines, bytes } = readFileStats(absolute);
		const proposal = { file: entry.file };
		if (hasLines && lines > entry.maxLines) {
			failures.push(`${entry.file}: ${lines}/${entry.maxLines} lines; split along documented seams or re-commit the ceiling in this diff with a one-line justification`);
			proposal.maxLines = Math.ceil(lines * 1.1);
			proposal.currentLines = lines;
			proposal.previousMaxLines = entry.maxLines;
		}
		if (hasBytes && bytes > entry.maxBytes) {
			failures.push(`${entry.file}: ${bytes}/${entry.maxBytes} bytes; roll older content out (e.g. npm run changelog:rotate) or re-commit the ceiling in this diff with a one-line justification`);
			proposal.maxBytes = Math.ceil(bytes * 1.1);
			proposal.currentBytes = bytes;
			proposal.previousMaxBytes = entry.maxBytes;
		}
		if (Object.keys(proposal).length > 1) {
			proposal.justification = "TODO: justify ceiling growth or shrink the file";
			proposals.push(proposal);
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
		const byteFail = check({ schemaVersion: 1, files: [{ file: "too-big.ts", maxBytes: 3 }] }, dir);
		assert(byteFail.failures.length === 1 && byteFail.failures[0].includes("bytes"), "file ceiling self-test must enforce maxBytes ceilings");
		const byteOk = check({ schemaVersion: 1, files: [{ file: "too-big.ts", maxBytes: 4096 }] }, dir);
		assert(byteOk.failures.length === 0, "file ceiling self-test must pass files within maxBytes");
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
