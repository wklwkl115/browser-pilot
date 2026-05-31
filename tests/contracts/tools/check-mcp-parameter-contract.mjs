/**
 * MCP parameter contract.
 *
 * Verifies that mcp/validation.ts replicates the Pi framework's TypeBox
 * Value.Convert + Check behavior: same coercion semantics, same rejection
 * patterns, so MCP callers get identical guarantees to Pi callers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source structure contracts ──────────────────────────────────────────────

const validationSrc = read("mcp/validation.ts");
assert(validationSrc.includes("Value.Convert"), "mcp/validation.ts must use Value.Convert for type coercion");
assert(validationSrc.includes("Value.Check"), "mcp/validation.ts must use Value.Check for validation");
assert(validationSrc.includes("Value.Errors"), "mcp/validation.ts must use Value.Errors to collect error messages");

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes('from "./validation.js"'), "mcp/index.ts must import from ./validation.js");
assert(indexSrc.includes("validateMcpToolArgs"), "mcp/index.ts must call validateMcpToolArgs");
assert(indexSrc.includes("validation.ok"), "mcp/index.ts must check validation result before def.execute");
assert(indexSrc.includes("validation.args"), "mcp/index.ts must pass validation.args (coerced) to def.execute");
assert(indexSrc.includes("notifications/progress"), "mcp/index.ts must map onUpdate to MCP progress notifications");

// ── Runtime behavior contract ───────────────────────────────────────────────

const { validateMcpToolArgs } = await import(
	new URL("../../../mcp/validation.ts", import.meta.url).href
);

// 1. Type coercion — string scalars converted to typed values
const strictSchema = Type.Object({
	flag: Type.Optional(Type.Boolean()),
	count: Type.Optional(Type.Number()),
	mode: Type.Optional(Type.Union([Type.Literal("scan"), Type.Literal("html")])),
}, { additionalProperties: false });

const coerced = validateMcpToolArgs(strictSchema, { flag: "true", count: "30", mode: "scan" });
assert.equal(coerced.ok, true, "valid args after coercion must return ok:true");
assert.equal(coerced.args.flag, true, "string 'true' must be coerced to boolean true");
assert.equal(coerced.args.count, 30, "string '30' must be coerced to number 30");
assert.equal(coerced.args.mode, "scan", "valid enum value must be preserved");

// 2. Unknown top-level keys rejected when additionalProperties:false
const withExtra = validateMcpToolArgs(strictSchema, { flag: true, count: 30, bogusField: 1 });
assert.equal(withExtra.ok, false, "unknown top-level fields must be rejected when additionalProperties:false");
assert.match(withExtra.error, /additional properties/i, "error must mention additional properties");

// 3. Invalid enum values rejected
const badEnum = validateMcpToolArgs(strictSchema, { mode: "bogus" });
assert.equal(badEnum.ok, false, "invalid literal-union enum values must be rejected");

// 4. No schema → pass-through
const noSchema = validateMcpToolArgs(undefined, { anything: true });
assert.equal(noSchema.ok, true, "no schema must pass through without validation");

// 5. Partial valid args (optional fields absent) → ok
const partial = validateMcpToolArgs(strictSchema, { mode: "html" });
assert.equal(partial.ok, true, "args with only optional fields present must be valid");

// 6. Null/undefined args → treated as empty object, must validate against schema
const nullArgs = validateMcpToolArgs(strictSchema, null);
assert.equal(nullArgs.ok, true, "null args must be treated as empty object (all fields optional → valid)");

console.log("mcp parameter contract ok");
