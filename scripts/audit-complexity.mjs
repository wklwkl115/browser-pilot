import { ESLint } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const complexityLimit = 20;
const expectedComplexFunctions = 93;
const functionLineLimit = 150;
const expectedLongFunctions = 0;

const eslint = new ESLint({
	cwd: root,
	overrideConfig: {
		rules: {
			complexity: ["warn", complexityLimit],
			"max-lines-per-function": ["warn", functionLineLimit],
		},
	},
});
const results = await eslint.lintFiles(["index.ts", "src"]);
const messages = results.flatMap((result) => result.messages);
const fatal = messages.find((message) => message.fatal);
if (fatal) throw new Error(`complexity audit could not parse source: ${fatal.message}`);

const complexFunctions = messages.filter((message) => message.ruleId === "complexity").length;
const longFunctions = messages.filter((message) => message.ruleId === "max-lines-per-function").length;

function assertExactBudget(label, actual, expected) {
	if (actual === expected) return;
	const direction = actual > expected ? "regressed above" : "improved below";
	throw new Error(`${label} ${direction} its ratchet: expected exactly ${expected}, found ${actual}. ${actual < expected ? "Lower the checked-in budget in scripts/audit-complexity.mjs." : "Refactor the new hotspot before merging."}`);
}

assertExactBudget(`functions with complexity > ${complexityLimit}`, complexFunctions, expectedComplexFunctions);
assertExactBudget(`functions longer than ${functionLineLimit} lines`, longFunctions, expectedLongFunctions);
console.log(`ok: complexity ratchet complexity>${complexityLimit}=${complexFunctions}; function-lines>${functionLineLimit}=${longFunctions}`);
