import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const CALL_SITE_LIMITS = [
	{ file: "src/tools/observe/scanRunner.ts", callee: "buildSnapshotProjection", maxCallSites: 1 },
	{ file: "src/tools/observe/scanRunner.ts", callee: "scanEntitiesForEnvelope", maxCallSites: 1 },
	{ file: "src/tools/observe/scanRunner.ts", callee: "buildScanEntities", maxCallSites: 1 },
	{ file: "src/tools/resultMiddleware.ts", callee: "envelopeEntities", maxCallSites: 1 },
	{ file: "src/tools/summaries/scan.ts", callee: "buildScanEntities", maxCallSites: 2 },
];

function countCallSites(text, callee) {
	const pattern = new RegExp(`\\b${callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
	let count = 0;
	let match;
	while ((match = pattern.exec(text)) !== null) {
		const lineStart = text.lastIndexOf("\n", match.index) + 1;
		const lineEnd = text.indexOf("\n", match.index);
		const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
		if (new RegExp(`\\bfunction\\s+${callee}\\b`).test(line)) continue;
		if (new RegExp(`\\bexport\\s+function\\s+${callee}\\b`).test(line)) continue;
		count += 1;
	}
	return count;
}

assert.equal(countCallSites("function buildX() {}\nbuildX();\nconst x = buildX (value);", "buildX"), 2, "compute-once counter self-test");

const results = [];
for (const item of CALL_SITE_LIMITS) {
	const text = readFileSync(path.join(root, item.file), "utf8");
	const actual = countCallSites(text, item.callee);
	assert(
		actual <= item.maxCallSites,
		`${item.file} calls ${item.callee} ${actual} time(s), max ${item.maxCallSites}; thread the computed value instead of recomputing. If the callee was intentionally renamed, update the CALL_SITE_LIMITS entry in this file.`,
	);
	results.push(`${item.file}:${item.callee}=${actual}/${item.maxCallSites}`);
}

console.log(`compute-once contract ok — ${results.join(", ")}`);
