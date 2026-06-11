import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenRuntimeReadLabels, stripStringLiterals } from "./purity-vocabulary.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distillCoreDir = path.join(root, "src", "distill-core");
const srcRoot = path.join(root, "src");

assert(existsSync(distillCoreDir), "src/distill-core/ must exist once the perception-renderer plan is active");

const PURE_CROSSCUTTING = new Set([
	"utils/json",
	"utils/records",
	"utils/redaction",
]);
const FORBIDDEN_SRC_PREFIXES = ["tools/", "driver/", "abml/", "abml-core/", "scan/", "resources/", "frontend/", "content/", "pick/"];
const NODE_IO_BUILTINS = new Set(["fs", "path", "os", "crypto", "http", "https", "net", "child_process", "url", "stream", "events", "util", "buffer"]);

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
const files = walk(distillCoreDir).sort();
assert(files.length > 0, "src/distill-core/ must contain classified pure kernel files");

const violations = [];
for (const fileRel of files) {
	const abs = path.join(distillCoreDir, fileRel);
	const text = readFileSync(abs, "utf8");
	assert(!/\b(process|window|document|chrome|browser)\b/.test(stripStringLiterals(text)), `src/distill-core/${fileRel} must not touch runtime/browser globals`);
	for (const label of forbiddenRuntimeReadLabels(text)) {
		assert.fail(`src/distill-core/${fileRel} must not use ${label}`);
	}
	for (const spec of importSources(text)) {
		if (spec.startsWith("node:")) {
			violations.push(`src/distill-core/${fileRel} imports node builtin ${spec}`);
			continue;
		}
		if (!spec.startsWith(".")) {
			if (NODE_IO_BUILTINS.has(spec.split("/")[0])) violations.push(`src/distill-core/${fileRel} imports node builtin ${spec}`);
			else violations.push(`src/distill-core/${fileRel} imports bare package ${spec}`);
			continue;
		}
		const fromDir = path.dirname(abs);
		const srcRel = stripExt(path.relative(srcRoot, path.normalize(path.join(fromDir, spec))).split(path.sep).join("/"));
		if (srcRel.startsWith("distill-core/")) continue;
		const forbidden = FORBIDDEN_SRC_PREFIXES.find((prefix) => srcRel.startsWith(prefix));
		if (forbidden) violations.push(`src/distill-core/${fileRel} imports forbidden src/${srcRel}`);
		else if (!PURE_CROSSCUTTING.has(srcRel)) violations.push(`src/distill-core/${fileRel} imports non-whitelisted src/${srcRel}`);
	}
}

assert.deepEqual(violations, [], `distill-core boundary violated:\n  - ${violations.join("\n  - ")}`);
console.log(`distill-core boundary ok — ${files.length} pure kernel file(s), ${PURE_CROSSCUTTING.size} whitelisted helpers`);
