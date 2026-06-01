/**
 * Unified MCP structured-envelope schema.
 *
 * Formalizes the stable shape of the distilled result envelope produced by
 * src/tools/resultMiddleware.ts (DistilledEnvelope). This is the schema for the
 * WHOLE envelope — distinct from the per-tool `summarySchema` (DistillerDefinition)
 * which validates only `structuredContent` (= envelope.summary).
 *
 * Field policy:
 * - `tool` + `detailLevel` are required, stable identity fields.
 * - `summary` is deliberately LOOSE: it is per-tool and fitSummaryBudget() can
 *   compact it down to a minimal fallback shape. (The same reason mcp/index.ts
 *   guards structuredContent emission with Value.Check against the per-tool schema.)
 * - `diagnostics/target/limits/privacy/nextActions/correlation/operation/snapshot/
 *   saved/sections` are the stable envelope-level fields, all optional.
 * - `sections` (Layer-1 handles) is populated by the MCP adapter, never by Pi core.
 */
import { Type } from "typebox";

const Loose = Type.Object({}, { additionalProperties: true });

/** Resource kinds — kept in sync with ResourceKind in mcp/resourceStore.ts. */
export const RESOURCE_KINDS = [
	"raw-result",
	"summary-section",
	"http-request",
	"network-entry",
	"scan",
	"evidence",
	"artifact-slice",
] as const;

const ResourceKindSchema = Type.Union(RESOURCE_KINDS.map((k) => Type.Literal(k)));

/** A Layer-1 section handle advertised in the envelope. */
export const SectionSchema = Type.Object(
	{
		name: Type.String(),
		kind: ResourceKindSchema,
		handle: Type.Optional(Type.String({ description: "browser-result:// URI for this section" })),
		count: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);

/** The full distilled-result envelope (MCP stable contract). */
export const StructuredEnvelopeSchema = Type.Object(
	{
		tool: Type.String(),
		command: Type.Optional(Type.String()),
		browserSessionId: Type.Optional(Type.String()),
		detailLevel: Type.String(),
		// Per-tool, budget-fitted — intentionally loose at the envelope level.
		summary: Loose,
		diagnostics: Type.Optional(Loose),
		target: Type.Optional(Loose),
		limits: Type.Optional(Loose),
		privacy: Type.Optional(Loose),
		nextActions: Type.Optional(Type.Array(Type.String())),
		correlation: Type.Optional(Loose),
		operation: Type.Optional(Loose),
		snapshot: Type.Optional(Loose),
		saved: Type.Optional(Loose),
		sections: Type.Optional(Type.Array(SectionSchema)),
	},
	{ additionalProperties: true },
);
