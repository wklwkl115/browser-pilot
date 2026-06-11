import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const inventory = JSON.parse(readFileSync(path.join(root, "tests/contracts/drift/kernel-export-inventory.json"), "utf8"));
const KERNEL_ROOTS = ["src/abml-core", "src/distill-core", "src/memory-core"];
const STATUSES = new Set(["consumed", "internal", "test-harness", "reserved"]);

function walk(relDir, predicate = () => true, prefix = "") {
	const out = [];
	for (const entry of readdirSync(path.join(root, relDir, prefix), { withFileTypes: true })) {
		const child = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(relDir, predicate, child));
		else if (predicate(entry.name, child)) out.push(`${relDir}/${child}`);
	}
	return out;
}

function walkMany(relDirs, predicate) {
	return relDirs.flatMap((relDir) => walk(relDir, predicate));
}

function exportedSymbols(text) {
	const out = [];
	for (const re of [
		/^export\s+(?:declare\s+)?(?:type|interface|function|const|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
		/^export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+["'][^"']+["'])?/gm,
		/^export\s+\*\s+from\s+["']([^"']+)["']/gm,
	]) {
		let match;
		while ((match = re.exec(text)) !== null) {
			if (match[1] && match[0].startsWith("export *")) {
				out.push(`* from ${match[1]}`);
				continue;
			}
			if (match[1] && match[0].includes("{")) {
				for (const raw of match[1].split(",")) {
					const part = raw.trim();
					if (!part) continue;
					out.push(part.split(/\s+as\s+/).pop().trim().replace(/^type\s+/, ""));
				}
				continue;
			}
			out.push(match[1]);
		}
	}
	return Array.from(new Set(out)).sort();
}

assert.deepEqual(exportedSymbols("export const A = 1;\nexport type { B as C } from './b.js';\nexport * from './x.js';"), ["* from ./x.js", "A", "C"], "surface export parser self-test");

function canonicalModule(rel) {
	if (rel.startsWith("src/abml/")) return `src/abml-core/${rel.slice("src/abml/".length)}`;
	return rel;
}

function resolvedImport(fromRel, spec) {
	if (!spec.startsWith(".")) return undefined;
	const abs = path.normalize(path.join(root, path.dirname(fromRel), spec));
	return canonicalModule(path.relative(root, abs).split(path.sep).join("/").replace(/\.(ts|js|mjs)$/i, "") + ".ts");
}

function importMap(files) {
	const byModule = new Map();
	for (const file of files) {
		const text = readFileSync(path.join(root, file), "utf8");
		for (const re of [
			/\bimport\s+type\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g,
			/\bimport\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g,
			/\bimport\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']+)["']/g,
			/\bfrom\s+["']([^"']+)["']/g,
		]) {
			let match;
			while ((match = re.exec(text)) !== null) {
				let names;
				let spec;
				if (match.length === 3) {
					names = match[1].split(",").map((item) => item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
					spec = match[2];
				} else {
					names = ["*"];
					spec = match[1];
				}
				const moduleRel = resolvedImport(file, spec);
				if (!moduleRel) continue;
				if (!byModule.has(moduleRel)) byModule.set(moduleRel, new Map());
				const byName = byModule.get(moduleRel);
				for (const name of names) {
					if (!byName.has(name)) byName.set(name, new Set());
					byName.get(name).add(file);
				}
			}
		}
	}
	return byModule;
}

function hasImport(map, moduleRel, symbol) {
	const byName = map.get(moduleRel);
	if (!byName) return false;
	return byName.has(symbol) || byName.has("*");
}

const allSourceFiles = [
	...walkMany(["src", "cli"], (name) => /\.(ts|mjs)$/.test(name)),
].filter((file) => !KERNEL_ROOTS.some((dir) => file.startsWith(`${dir}/`)) && !file.startsWith("src/abml/"));
const testFiles = walk("tests", (name) => /\.(ts|mjs)$/.test(name));
const sourceImports = importMap(allSourceFiles);
const testImports = importMap(testFiles);

const actualModules = new Map(KERNEL_ROOTS
	.flatMap((dir) => walk(dir, (name) => name.endsWith(".ts")))
	.map((file) => [file, exportedSymbols(readFileSync(path.join(root, file), "utf8"))]));

assert.deepEqual(
	[...actualModules.keys()].sort(),
	Object.keys(inventory.modules).sort(),
	"kernel export inventory module set drifted; regenerate/classify the ledger",
);

let reservedCount = 0;
for (const [moduleRel, actualExports] of actualModules) {
	const entry = inventory.modules[moduleRel];
	const listedExports = (entry.exports || []).map((item) => item.name).sort();
	assert.deepEqual(listedExports, actualExports, `${moduleRel} export ledger drifted; classify added/removed exports`);
	for (const item of entry.exports || []) {
		assert(STATUSES.has(item.status), `${moduleRel}:${item.name} has invalid status ${item.status}`);
		if (item.status === "consumed") {
			assert(hasImport(sourceImports, moduleRel, item.name), `${moduleRel}:${item.name} is marked consumed but has no kernel-external production importer`);
		}
		if (item.status === "test-harness") {
			assert(hasImport(testImports, moduleRel, item.name), `${moduleRel}:${item.name} is marked test-harness but no test imports it`);
		}
		if (item.status === "reserved") {
			reservedCount += 1;
			assert(typeof item.bar === "string" && item.bar.trim().length > 0, `${moduleRel}:${item.name} reserved entry must carry a promotion bar`);
		}
	}
	for (const member of entry.members || []) {
		const source = readFileSync(path.join(root, moduleRel), "utf8");
		const field = String(member.name).split(".").pop();
		assert(source.includes(field), `${moduleRel}:${member.name} member ledger entry is stale`);
		assert(STATUSES.has(member.status), `${moduleRel}:${member.name} has invalid status ${member.status}`);
		if (member.status === "reserved") {
			reservedCount += 1;
			assert(typeof member.bar === "string" && member.bar.trim().length > 0, `${moduleRel}:${member.name} reserved member must carry a promotion bar`);
		}
	}
}

assert.equal(reservedCount, inventory.reservedCount, "kernel export reservedCount baseline must match reserved entries");
console.log(`surface liveness ok — modules=${actualModules.size}, reserved=${reservedCount}`);
