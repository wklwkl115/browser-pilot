import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenRuntimeReadLabels, stripStringLiterals } from "./purity-vocabulary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const memoryCoreDir = path.join(root, "src", "memory-core");
const srcRoot = path.join(root, "src");

assert(existsSync(memoryCoreDir), "src/memory-core/ must exist once the memory-kernel plan is active");

const FORBIDDEN_SRC_PREFIXES = ["tools/", "driver/", "abml/", "abml-core/", "distill-core/", "scan/", "resources/", "frontend/", "content/", "pick/", "memory/"];
const NODE_BUILTINS = new Set(["fs", "path", "os", "crypto", "http", "https", "net", "child_process", "url", "stream", "events", "util", "buffer"]);

function walk(dir, rel = "") {
	const out = [];
	for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(dir, childRel));
		else if (entry.name.endsWith(".ts")) out.push(childRel);
	}
	return out;
}

function importSources(text) {
	const sources = [];
	for (const re of [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\s+["']([^"']+)["']/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	]) {
		let match;
		while ((match = re.exec(text)) !== null) sources.push(match[1]);
	}
	return sources;
}

const stripExt = (value) => value.replace(/\.(ts|js|mjs)$/i, "");
const files = walk(memoryCoreDir).sort();
assert(files.length > 0, "src/memory-core/ must contain pure kernel files");

const violations = [];
for (const fileRel of files) {
	const abs = path.join(memoryCoreDir, fileRel);
	const text = readFileSync(abs, "utf8");
	assert(!/\b(process|window|document|chrome|browser)\b/.test(stripStringLiterals(text)), `src/memory-core/${fileRel} must not touch runtime/browser globals`);
	for (const label of forbiddenRuntimeReadLabels(text)) {
		assert.fail(`src/memory-core/${fileRel} must not use ${label}`);
	}
	for (const spec of importSources(text)) {
		if (spec.startsWith("node:")) {
			violations.push(`src/memory-core/${fileRel} imports node builtin ${spec}`);
			continue;
		}
		if (!spec.startsWith(".")) {
			if (NODE_BUILTINS.has(spec.split("/")[0])) violations.push(`src/memory-core/${fileRel} imports node builtin ${spec}`);
			else violations.push(`src/memory-core/${fileRel} imports bare package ${spec}`);
			continue;
		}
		const fromDir = path.dirname(abs);
		const srcRel = stripExt(path.relative(srcRoot, path.normalize(path.join(fromDir, spec))).split(path.sep).join("/"));
		if (srcRel.startsWith("memory-core/")) continue;
		const forbidden = FORBIDDEN_SRC_PREFIXES.find((prefix) => srcRel.startsWith(prefix));
		if (forbidden) violations.push(`src/memory-core/${fileRel} imports forbidden src/${srcRel}`);
		else violations.push(`src/memory-core/${fileRel} imports non-core src/${srcRel}`);
	}
}

assert.deepEqual(violations, [], `memory-core boundary violated:\n  - ${violations.join("\n  - ")}`);
console.log(`memory-core boundary ok — ${files.length} pure kernel file(s)`);
