// CLI migration drift guard (the P0 deliverable of docs/cli-skill-frontend-migration-plan.md).
//
// The MCP shell is gone and browser-pilot is the sole external frontend. This locks that in:
// active code (index.ts + src/** + cli/**) must not reintroduce MCP-only identifiers. It is a
// permanent regression guard, not a one-off cleanup — if anyone re-adds an mcp/ import, the
// browser-pilot-mcp bin, the SDK, the removed discovery tool, or the MCP-only env vars, CI goes red.
//
// Scope is ACTIVE CODE only. Historical/explanatory prose in docs/ may still mention "MCP".
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

function walk(rel) {
	const abs = path.join(root, rel);
	if (!existsSync(abs)) return [];
	const out = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const child = `${rel}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(child));
		else if (/\.(ts|mjs|cjs|js)$/.test(entry.name)) out.push(child);
	}
	return out;
}

// Each rule: a label + a regex that must NOT match anywhere in active code.
const FORBIDDEN = [
	{ label: "import from mcp/ (the shell was removed)", re: /from\s*["'][^"']*\bmcp\//, },
	{ label: "dist/mcp reference", re: /dist\/mcp\b/ },
	{ label: "browser-pilot-mcp bin name", re: /browser-pilot-mcp/ },
	{ label: "@modelcontextprotocol SDK", re: /@modelcontextprotocol/ },
	{ label: "browser_tool_discovery (MCP-only discovery tool, removed)", re: /browser_tool_discovery/ },
	{ label: "PI_BROWSER_MCP_* env (MCP-only knobs, removed)", re: /PI_BROWSER_MCP_/ },
];

const files = [...(existsSync(path.join(root, "index.ts")) ? ["index.ts"] : []), ...walk("src"), ...walk("cli")];
assert(files.length > 50, "active-code scan should see the full src/cli tree");

const violations = [];
for (const file of files) {
	const text = read(file);
	for (const rule of FORBIDDEN) {
		const lines = text.split(/\r?\n/);
		lines.forEach((line, i) => {
			if (rule.re.test(line)) violations.push(`${file}:${i + 1} — ${rule.label}: ${line.trim().slice(0, 100)}`);
		});
	}
}
assert.deepEqual(violations, [], `CLI migration drift — MCP-only identifiers must not reappear in active code:\n  - ${violations.join("\n  - ")}`);

// The mcp/ directory itself must stay deleted.
assert(!existsSync(path.join(root, "mcp")), "mcp/ must remain deleted after the CLI migration");

console.log(`cli migration drift ok — scanned ${files.length} active files, no MCP-only identifiers, mcp/ absent`);
