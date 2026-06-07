import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const summariesDir = path.join(root, "src", "tools", "summaries");

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

for (const file of walk(summariesDir)) {
	const rel = path.relative(root, file).replace(/\\/g, "/");
	const text = readFileSync(file, "utf8");
	assert(!text.includes("registerRefDescriptor"), `${rel} must not mint pi-ref registry entries`);
	assert(!/from\s+["'][^"']*resources\//.test(text), `${rel} must not import resource-store writers`);
}

console.log("summary boundary ok — distillers do not write ref/resource registries");
