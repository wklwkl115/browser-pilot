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

// Must NOT claim capabilities that aren't implemented yet
assert(!indexSrc.includes("resources: {"), "mcp/index.ts must not declare resources capability before Phase 4");
assert(!indexSrc.includes("prompts: {"), "mcp/index.ts must not declare prompts capability before it is implemented");

// tools capability must be declared (already present from initial setup)
assert(indexSrc.includes("capabilities:") && indexSrc.includes("tools:"), "mcp/index.ts must declare tools capability");

// ── TypeBox schema pass-through (no Zod conversion at top level) ──────────────

// Must NOT use McpServer.registerTool (that path requires Zod schemas)
assert(!indexSrc.includes("McpServer"), "mcp/index.ts must not use high-level McpServer (forces Zod on tool params)");
assert(!indexSrc.includes("registerTool("), "mcp/index.ts must use low-level Server + explicit ListTools/CallTool handlers");
assert(indexSrc.includes("ListToolsRequestSchema") && indexSrc.includes("CallToolRequestSchema"), "mcp/index.ts must use low-level ListTools/CallTool request schemas");

// inputSchema must be the TypeBox-generated schema (passed through directly)
assert(indexSrc.includes("def.parameters"), "mcp/index.ts tools/list must reference def.parameters for inputSchema");

// ── outputSchema / structuredContent (Phase 3) ───────────────────────────────

// For tools with DistillerDefinition, outputSchema must appear in tools/list
assert(indexSrc.includes("getDistillerDefinition"), "mcp/index.ts must import getDistillerDefinition for outputSchema");
assert(indexSrc.includes("distillerDef?.summarySchema"), "mcp/index.ts tools/list must include outputSchema from summarySchema");
// structuredContent must be extracted from distilled envelope for spike tools
assert(indexSrc.includes("structuredContent"), "mcp/index.ts tools/call must include structuredContent for distilled tools");
assert(indexSrc.includes("envelope.summary"), "mcp/index.ts must extract summary field from distilled envelope JSON");

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

// ── Progress / onUpdate mapping ───────────────────────────────────────────────

assert(indexSrc.includes("notifications/progress"), "mcp/index.ts must map onUpdate to MCP progress notifications");
assert(indexSrc.includes("progressToken"), "mcp/index.ts must gate progress notifications on progressToken presence");

// ── Validation module structure ───────────────────────────────────────────────

assert(validationSrc.includes("export function validateMcpToolArgs"), "mcp/validation.ts must export validateMcpToolArgs");
assert(validationSrc.includes("McpValidationResult"), "mcp/validation.ts must export McpValidationResult type");
assert(validationSrc.includes("ok: true") && validationSrc.includes("ok: false"), "McpValidationResult must discriminate ok:true/false");

// ── Adapter still collects tool definitions ───────────────────────────────────

assert(adapterSrc.includes("registerTool") && adapterSrc.includes("getTools"), "mcp/adapter.ts must implement registerTool + getTools collection");
assert(adapterSrc.includes("import type") && adapterSrc.includes("@earendil-works/pi-coding-agent"), "mcp/adapter.ts dependency must remain type-only (runtime zero dep)");

console.log("mcp conformance ok");
