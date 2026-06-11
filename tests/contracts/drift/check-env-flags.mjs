import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const registry = JSON.parse(readFileSync(path.join(root, "tests/contracts/drift/env-flags.json"), "utf8"));

function walk(dir, rel = "") {
	const out = [];
	for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(dir, childRel));
		else if (/\.(ts|mjs)$/.test(entry.name)) out.push(path.join(dir, childRel));
	}
	return out;
}

function envHits(text) {
	const names = new Set();
	for (const re of [
		/\bprocess\.env\.((?:PI_BROWSER_)[A-Z0-9_]+)/g,
		/\bprocess\.env\[\s*["']((?:PI_BROWSER_)[A-Z0-9_]+)["']\s*\]/g,
		/\benv\[\s*["']((?:PI_BROWSER_)[A-Z0-9_]+)["']\s*\]/g,
	]) {
		let match;
		while ((match = re.exec(text)) !== null) names.add(match[1]);
	}
	return names;
}

assert.deepEqual(
	Array.from(envHits("process.env.PI_BROWSER_A; process.env['PI_BROWSER_B']; env[\"PI_BROWSER_C\"]")).sort(),
	["PI_BROWSER_A", "PI_BROWSER_B", "PI_BROWSER_C"],
	"env flag extractor self-test",
);

const sourceRoots = registry.sourceRoots ?? ["src"];
const hitsByName = new Map();
for (const sourceRoot of sourceRoots) {
	for (const file of walk(path.join(root, sourceRoot))) {
		const rel = path.relative(root, file).split(path.sep).join("/");
		for (const name of envHits(readFileSync(file, "utf8"))) {
			if (!hitsByName.has(name)) hitsByName.set(name, []);
			hitsByName.get(name).push(rel);
		}
	}
}

const registered = new Map(registry.flags.map((flag) => [flag.name, flag]));
const unknown = [...hitsByName.keys()].filter((name) => !registered.has(name)).sort();
assert.deepEqual(unknown, [], `unregistered PI_BROWSER_* source env flag(s): ${unknown.join(", ")}`);

const stale = [...registered.keys()].filter((name) => !hitsByName.has(name)).sort();
assert.deepEqual(stale, [], `stale PI_BROWSER_* registry entry with zero source hits: ${stale.join(", ")}`);

for (const flag of registry.flags) {
	assert.equal(typeof flag.affectsOutput, "boolean", `${flag.name} must declare affectsOutput`);
	if (!flag.affectsOutput) continue;
	assert(Array.isArray(flag.signatureSites) && flag.signatureSites.length > 0, `${flag.name} affects output and must declare signatureSites`);
	for (const site of flag.signatureSites) {
		const text = readFileSync(path.join(root, site.file), "utf8");
		for (const marker of site.markers || []) {
			assert(text.includes(marker), `${flag.name} signature site ${site.file} missing marker ${marker}`);
		}
	}
}

console.log(`env flag contract ok — ${registry.flags.length} registered flag(s), roots=${sourceRoots.join(",")}`);
