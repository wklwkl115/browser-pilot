import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const map = JSON.parse(readFileSync(path.join(root, "tests/contracts/drift/kernel-test-map.json"), "utf8"));
const mapRel = "tests/contracts/drift/kernel-test-map.json";
const proposeMode = process.argv.includes("--propose");
const KERNEL_ROOTS = ["src/abml-core", "src/distill-core", "src/memory-core", "src/temporal-core"];

function walk(relDir, prefix = "") {
	const out = [];
	for (const entry of readdirSync(path.join(root, relDir, prefix), { withFileTypes: true })) {
		const child = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(relDir, child));
		else if (entry.name.endsWith(".ts")) out.push(`${relDir}/${child}`);
	}
	return out;
}

function canonicalModule(rel) {
	if (rel.startsWith("src/abml/")) return `src/abml-core/${rel.slice("src/abml/".length)}`;
	return rel;
}

function resolvedImport(fromRel, spec) {
	if (!spec.startsWith(".")) return undefined;
	const abs = path.normalize(path.join(root, path.dirname(fromRel), spec));
	return canonicalModule(path.relative(root, abs).split(path.sep).join("/").replace(/\.(ts|js|mjs)$/i, "") + ".ts");
}

function importsModule(testRel, moduleRel) {
	const text = readFileSync(path.join(root, testRel), "utf8");
	for (const re of [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*new URL\(\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\bimport\s+["']([^"']+)["']/g,
	]) {
		let match;
		while ((match = re.exec(text)) !== null) {
			if (resolvedImport(testRel, match[1]) === moduleRel) return true;
		}
	}
	return false;
}

assert.equal(resolvedImport("tests/unit/abml/verbs.test.ts", "../../../src/abml/verbs/click.ts"), "src/abml-core/verbs/click.ts", "kernel-test-map shim canonicalization self-test");

const modules = KERNEL_ROOTS.flatMap((relDir) => walk(relDir)).sort();
const mapped = new Set(Object.keys(map.mapped || {}));
const grandfathered = new Set(Object.keys(map.grandfathered || {}));
const actual = new Set(modules);
const stale = [...mapped, ...grandfathered].filter((moduleRel) => !actual.has(moduleRel)).sort();
const missing = modules.filter((moduleRel) => !mapped.has(moduleRel) && !grandfathered.has(moduleRel));

if (proposeMode) {
	if (!stale.length && !missing.length && grandfathered.size <= map.grandfatherMax) {
		console.log("kernel-test-map propose: no changes needed");
		process.exit(0);
	}
	const proposed = JSON.parse(JSON.stringify(map));
	for (const moduleRel of stale) {
		delete proposed.mapped?.[moduleRel];
		delete proposed.grandfathered?.[moduleRel];
	}
	for (const moduleRel of missing) {
		proposed.mapped = proposed.mapped || {};
		proposed.mapped[moduleRel] = ["TODO: add direct test path importing this module"];
	}
	console.log(`kernel-test-map propose: update ${mapRel}; replace TODO entries with real direct tests or a justified grandfather entry:`);
	console.log(JSON.stringify({ ...proposed, justification: "TODO: justify any added grandfathered module and its removal bar" }, null, 2));
	process.exit(0);
}

for (const moduleRel of [...mapped, ...grandfathered]) {
	assert(actual.has(moduleRel), `kernel-test-map stale entry: ${moduleRel} (run npm run check:kernel-test-map -- --propose for a draft)`);
}

assert.deepEqual(missing, [], `kernel module(s) need direct test map or grandfather decision: ${missing.join(", ")} (run npm run check:kernel-test-map -- --propose for a draft)`);

assert(grandfathered.size <= map.grandfatherMax, `kernel test grandfather count may only shrink: ${grandfathered.size} > ${map.grandfatherMax} (run npm run check:kernel-test-map -- --propose for a draft)`);
for (const [moduleRel, reason] of Object.entries(map.grandfathered || {})) {
	assert(typeof reason === "string" && reason.trim().length >= 12, `${moduleRel} grandfather entry must carry a concrete reason/removal bar`);
}

for (const [moduleRel, tests] of Object.entries(map.mapped || {})) {
	assert(Array.isArray(tests) && tests.length > 0, `${moduleRel} must list at least one direct test`);
	for (const testRel of tests) {
		assert(existsSync(path.join(root, testRel)), `${moduleRel} mapped test is missing: ${testRel}`);
		assert(importsModule(testRel, moduleRel), `${testRel} must directly import ${moduleRel} or its src/abml shim`);
	}
}

console.log(`kernel test map ok — mapped=${mapped.size}, grandfathered=${grandfathered.size}/${map.grandfatherMax}`);
