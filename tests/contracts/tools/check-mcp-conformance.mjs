/**
 * MCP conformance contract.
 *
 * Verifies structural conformance of the MCP server entry:
 * - Correct capabilities declaration
 * - tools/list handler present and returns TypeBox-generated schemas
 * - tools/call handler validates args before execute
 * - onUpdate → progress notification mapping present
 * - No McpServer.registerTool (would force Zod on top-level params)
 * - No direct bypass of validation (def.execute called with validation.args)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const indexSrc = read("mcp/index.ts");
const validationSrc = read("mcp/validation.ts");
const adapterSrc = read("mcp/adapter.ts");

// ── Capabilities ─────────────────────────────────────────────────────────────

// Phase 4: resources capability must be declared (Phase 4+ only)
assert(indexSrc.includes("resources: {}"), "mcp/index.ts must declare resources capability (Phase 4)");
assert(indexSrc.includes("prompts: {}"), "mcp/index.ts must declare prompts capability with Phase 9 prompts implemented");
assert(indexSrc.includes("ListPromptsRequestSchema") && indexSrc.includes("GetPromptRequestSchema"), "mcp/index.ts must handle prompts/list and prompts/get");

// tools capability must be declared (already present from initial setup)
assert(indexSrc.includes("capabilities:") && indexSrc.includes("tools:"), "mcp/index.ts must declare tools capability");

// ── TypeBox schema pass-through (no Zod conversion at top level) ──────────────

// Must NOT use McpServer.registerTool (that path requires Zod schemas)
assert(!indexSrc.includes("McpServer"), "mcp/index.ts must not use high-level McpServer (forces Zod on tool params)");
assert(!indexSrc.includes("registerTool("), "mcp/index.ts must use low-level Server + explicit ListTools/CallTool handlers");
assert(indexSrc.includes("ListToolsRequestSchema") && indexSrc.includes("CallToolRequestSchema"), "mcp/index.ts must use low-level ListTools/CallTool request schemas");
assert(indexSrc.includes("tools: { listChanged: true }") && indexSrc.includes("sendToolListChanged"), "Phase 9 dynamic tools/list must declare listChanged and emit the paired notification");

// inputSchema must be the TypeBox-generated schema (passed through directly)
assert(indexSrc.includes("def.parameters"), "mcp/index.ts tools/list must reference def.parameters for inputSchema");

// ── outputSchema / structuredContent (Phase 3) ───────────────────────────────

// For tools with DistillerDefinition, outputSchema must appear in tools/list
assert(indexSrc.includes("getDistillerDefinition"), "mcp/index.ts must import getDistillerDefinition for outputSchema");
assert(indexSrc.includes("distillerDef?.summarySchema"), "mcp/index.ts tools/list must include outputSchema from summarySchema");
// structuredContent must be extracted from distilled envelope for spike tools
assert(indexSrc.includes("structuredContent"), "mcp/index.ts tools/call must include structuredContent for distilled tools");
assert(indexSrc.includes("envelope.summary"), "mcp/index.ts must extract summary field from distilled envelope JSON");
// MCP spec: structuredContent MUST conform to outputSchema. Budget-fitting can
// drop required fields, so emission MUST be gated on Value.Check against the schema.
assert(indexSrc.includes("Value.Check(distillerDef.summarySchema"),
	"mcp/index.ts must gate structuredContent on Value.Check(summarySchema) so it never emits non-conforming structuredContent");

// ── Validation before execute ─────────────────────────────────────────────────

// Validation must happen before def.execute, not after
const callHandlerMatch = indexSrc.match(/CallToolRequestSchema[\s\S]*?(?=\/\/ ─── Start)/);
assert(callHandlerMatch, "mcp/index.ts must have a CallTool handler section");
const callHandler = callHandlerMatch[0];

const validatePos = callHandler.indexOf("validateMcpToolArgs");
const executePos = callHandler.indexOf("def.execute");
assert(validatePos !== -1, "CallTool handler must call validateMcpToolArgs");
assert(executePos !== -1, "CallTool handler must call def.execute");
assert(validatePos < executePos, "validateMcpToolArgs must be called BEFORE def.execute");

// Execute must receive validation.args (coerced), not raw args
assert(callHandler.includes("validation.args"), "def.execute must receive validation.args (coerced), not raw args");

// ── No silent paths: every tools/call early-return logs (plan §2) ─────────────
// Each isError early return in the call handler must be paired with an emitLog so
// no degradation/rejection path is silent.
{
	const callBody = callHandler;
	const isErrorReturns = (callBody.match(/isError:\s*true/g) || []).length;
	const emitLogCalls = (callBody.match(/emitLog\(/g) || []).length;
	assert(emitLogCalls >= isErrorReturns,
		`tools/call must log every error path: found ${isErrorReturns} isError returns but only ${emitLogCalls} emitLog calls`);
	assert(callBody.includes("INVALID_PARAMS"), "tools/call validation-reject branch must log INVALID_PARAMS");
}

// ── Progress / onUpdate mapping ───────────────────────────────────────────────

assert(indexSrc.includes("notifications/progress"), "mcp/index.ts must map onUpdate to MCP progress notifications");
assert(indexSrc.includes("progressToken"), "mcp/index.ts must gate progress notifications on progressToken presence");

// ── Validation module structure ───────────────────────────────────────────────

assert(validationSrc.includes("export function validateMcpToolArgs"), "mcp/validation.ts must export validateMcpToolArgs");
assert(validationSrc.includes("McpValidationResult"), "mcp/validation.ts must export McpValidationResult type");
assert(validationSrc.includes("ok: true") && validationSrc.includes("ok: false"), "McpValidationResult must discriminate ok:true/false");

// ── Phase 8: browser_artifact capability-gated retirement ────────────────────

assert(indexSrc.includes("browser_artifact"), "mcp/index.ts Phase 8 must reference browser_artifact by name");
assert(indexSrc.includes("visibleTools"), "mcp/index.ts Phase 8 must define visibleTools filtered list");
assert(indexSrc.includes("PI_BROWSER_MCP_KEEP_ARTIFACT"), "mcp/index.ts Phase 8 must support opt-out via PI_BROWSER_MCP_KEEP_ARTIFACT env var");
assert(indexSrc.includes("resolveMcpToolVisibilityOptions") && indexSrc.includes("keepArtifact"), "mcp/index.ts Phase 8 must route browser_artifact retirement through MCP visibility options");
assert(indexSrc.includes("memoryEvidenceResolver: resolveBrowserResultEvidence"), "mcp/index.ts must inject browser-result evidence resolver into registerBrowserTools for browser_memory");

// ── Phase 5: nextActions adapter transformation ───────────────────────────────

assert(indexSrc.includes("browser_artifact path=") || indexSrc.includes("read_saved_artifact"), "mcp/index.ts must detect core nextActions that need MCP resource adaptation");
assert(indexSrc.includes("resources/read uri="), "mcp/index.ts Phase 5/P8 must replace with resources/read uri= in nextActions");
assert(indexSrc.includes("adaptedNextActions"), "mcp/index.ts Phase 5/P8 must produce adaptedNextActions for MCP callers");

// ── Adapter still collects tool definitions ───────────────────────────────────

assert(adapterSrc.includes("registerTool") && adapterSrc.includes("getTools"), "mcp/adapter.ts must implement registerTool + getTools collection");
assert(adapterSrc.includes("import type") && adapterSrc.includes("@earendil-works/pi-coding-agent"), "mcp/adapter.ts dependency must remain type-only (runtime zero dep)");

console.log("mcp conformance ok");
