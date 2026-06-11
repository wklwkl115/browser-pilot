import assert from "node:assert/strict";
import { forbiddenRuntimeReadLabels, PURE_RUNTIME_READ_PATTERNS } from "./purity-vocabulary.js";

const positives = {
	"Date.now(": "const value = Date.now();",
	"Math.random(": "const value = Math.random();",
	"new Date(": "const value = new Date();",
	"performance.now(": "const value = performance.now();",
	"localeCompare(": "items.sort((a, b) => a.localeCompare(b));",
	"toLocale*(": "value.toLocaleString();",
	"process.env": "const value = process.env.PI_BROWSER_RENDERER;",
};

for (const { label } of PURE_RUNTIME_READ_PATTERNS) {
	assert(
		forbiddenRuntimeReadLabels(positives[label]).includes(label),
		`purity vocabulary synthetic positive must match ${label}`,
	);
}

const negative = `
const text = "Date.now() Math.random() new Date() performance.now() process.env";
const stable = value.toLowerCase();
`;
assert.deepEqual(forbiddenRuntimeReadLabels(negative), [], "purity vocabulary must ignore string literals and safe methods");

console.log(`purity vocabulary ok — ${PURE_RUNTIME_READ_PATTERNS.length} runtime-read pattern(s)`);
