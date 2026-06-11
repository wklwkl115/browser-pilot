import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompactionTuningBounds } from "../../../src/distill-core/compactionTuning.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const srcRoot = path.join(root, "src");
const ledgerPath = path.join(root, "docs", "compaction-ledger.json");
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function relPath(file) {
	return path.relative(root, file).replace(/\\/g, "/");
}

function ruleMatches(rule, rel, line) {
	if (rule.file && rule.file !== rel) return false;
	if (rule.filePrefix && !rel.startsWith(rule.filePrefix)) return false;
	if (rule.contains && !line.includes(rule.contains)) return false;
	return !!(rule.file || rule.filePrefix);
}

const rules = ledger.rules ?? [];
const migrations = ledger.migrations ?? [];
const requiredSeedIds = new Set(ledger.requiredSeedIds ?? []);
const allIds = new Set([...rules, ...migrations].map((entry) => entry.id));
for (const id of requiredSeedIds) assert.ok(allIds.has(id), `compaction ledger missing required seed id: ${id}`);
assertCompactionTuningBounds();

const sliceRe = /\.slice\(0,\s*[^)]*\)/g;
const uncovered = [];
const migratedStillPresent = [];
const seen = [];
let classBCurrent = 0;

for (const file of walk(srcRoot)) {
	const rel = relPath(file);
	const lines = readFileSync(file, "utf8").split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		sliceRe.lastIndex = 0;
		if (!sliceRe.test(line)) continue;
		const activeRules = rules.filter((rule) => rule.status !== "migrated" && ruleMatches(rule, rel, line));
		const migratedRules = [...rules, ...migrations].filter((rule) => rule.status === "migrated" && ruleMatches(rule, rel, line));
		if (migratedRules.length) migratedStillPresent.push(`${rel}:${index + 1} matched migrated ${migratedRules.map((rule) => rule.id).join(",")}`);
		if (!activeRules.length) {
			uncovered.push(`${rel}:${index + 1}: ${line.trim()}`);
			continue;
		}
		const rule = activeRules[0];
		seen.push({ rel, line: index + 1, class: rule.class, rule: rule.id });
		if (rule.class === "B") classBCurrent += 1;
	}
}

assert.deepEqual(uncovered, [], `compaction ledger has uncovered slice(0, N)-class sites:\n  - ${uncovered.join("\n  - ")}`);
assert.deepEqual(migratedStillPresent, [], `compaction ledger migrated entries still match live slice sites:\n  - ${migratedStillPresent.join("\n  - ")}`);

const migratedClassB = migrations.filter((entry) => entry.class === "B" && entry.status === "migrated").length;
assert.ok(migratedClassB >= Number(ledger.requiredClassBDecrements ?? 0), `compaction ledger requires at least ${ledger.requiredClassBDecrements} class-B decrement(s), saw ${migratedClassB}`);
assert.ok(classBCurrent <= Number(ledger.classBBaseline), `class-B compaction sites grew past baseline: current=${classBCurrent}, baseline=${ledger.classBBaseline}`);

console.log(`compaction ledger ok — slice sites=${seen.length}, classB=${classBCurrent}/${ledger.classBBaseline}, migratedB=${migratedClassB}`);
