/**
 * MCP tools/list snapshot contract.
 *
 * Verifies that:
 * - All registered tools are exposed via McpExtensionAdapter.getTools()
 * - Each tool has annotations (readOnly/destructive/idempotent/openWorld hints)
 * - Core profile = 15 tools, security profile = 22 tools
 * - Annotation table covers all registered tool names
 * - Security tools are the expected 7 names
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const annotationsSrc = read("mcp/toolAnnotations.ts");
assert(annotationsSrc.includes("TOOL_ANNOTATIONS"), "mcp/toolAnnotations.ts must export TOOL_ANNOTATIONS");
assert(annotationsSrc.includes("readOnlyHint"), "TOOL_ANNOTATIONS must include readOnlyHint entries");
assert(annotationsSrc.includes("openWorldHint"), "TOOL_ANNOTATIONS must include openWorldHint entries");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes('from "./toolAnnotations.js"'), "mcp/index.ts must import toolAnnotations");
assert(indexSrc.includes("TOOL_ANNOTATIONS[def.name]"), "mcp/index.ts tools/list must include tool annotations");

// ── Runtime tool count contracts ──────────────────────────────────────────────

const { McpExtensionAdapter } = await import(
	new URL("../../../mcp/adapter.ts", import.meta.url).href
);
const { registerBrowserTools } = await import(
	new URL("../../../src/tools/registerTools.ts", import.meta.url).href
);
const { resolveBrowserToolCapabilityProfile } = await import(
	new URL("../../../src/tools/capabilityProfile.ts", import.meta.url).href
);
const { TOOL_ANNOTATIONS } = await import(
	new URL("../../../mcp/toolAnnotations.ts", import.meta.url).href
);

// Core profile (default)
const coreAdapter = new McpExtensionAdapter();
const coreBridgePlaceholder = { setCapabilityProfile: () => {} };
registerBrowserTools(coreAdapter, coreBridgePlaceholder, async () => coreBridgePlaceholder, {
	securityToolsEnabled: false,
});
const coreTools = coreAdapter.getTools();
assert.equal(coreTools.length, 15, `core profile must register exactly 15 tools, got ${coreTools.length}`);

// Security profile
const secAdapter = new McpExtensionAdapter();
registerBrowserTools(secAdapter, coreBridgePlaceholder, async () => coreBridgePlaceholder, {
	securityToolsEnabled: true,
});
const secTools = secAdapter.getTools();
assert.equal(secTools.length, 22, `security profile must register exactly 22 tools, got ${secTools.length}`);

// ── Annotation coverage ───────────────────────────────────────────────────────

const annotated = new Set(Object.keys(TOOL_ANNOTATIONS));
for (const def of secTools) {
	assert(annotated.has(def.name), `TOOL_ANNOTATIONS must cover ${def.name}`);
}

// ── Annotation shapes ────────────────────────────────────────────────────────

const SECURITY_TOOL_NAMES = new Set([
	"browser_crawl", "browser_fuzz", "browser_sqli", "browser_template",
	"browser_callback_oast", "browser_cookie_analyze", "browser_http_replay",
]);

for (const def of secTools) {
	const ann = TOOL_ANNOTATIONS[def.name];
	assert(ann !== undefined, `missing annotations for ${def.name}`);
	// Security tools and open-world core tools must declare openWorldHint
	if (SECURITY_TOOL_NAMES.has(def.name)) {
		assert.equal(ann.openWorldHint, true, `${def.name} must have openWorldHint:true`);
	}
	// Read-only tools must not be destructive
	if (ann.readOnlyHint === true) {
		assert(ann.destructiveHint !== true, `${def.name} is readOnly but has destructiveHint:true`);
	}
}

// ── Security tool set verification ───────────────────────────────────────────

const coreNames = new Set(coreTools.map((t) => t.name));
const secNames = new Set(secTools.map((t) => t.name));
for (const name of SECURITY_TOOL_NAMES) {
	assert(!coreNames.has(name), `${name} must not appear in core profile`);
	assert(secNames.has(name), `${name} must appear in security profile`);
}
assert.equal(secTools.length - coreTools.length, 7, "security profile must add exactly 7 tools over core");

console.log("mcp tools/list snapshot ok");
