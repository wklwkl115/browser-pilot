import { Type } from "typebox";
import { createCodedError } from "../utils/codedError.js";
import { compactError } from "../utils/errors.js";
import { defineBrowserTool, jsonToolResult, runTool, toolMaxChars } from "./toolAdapter.js";
import type { ToolRegistrarContext } from "./toolShared.js";
import { enumParam, strictToolParameters } from "./toolShared.js";
import { readBrowserMemory } from "./memory/reader.js";
import { recordMemoryEntry, recallMemory, validateMemoryRecord } from "./memory/store.js";
import type { MemoryReadMode, MemoryRecordPayload } from "./memory/types.js";
import { browserMemoryUriForEntry } from "./memory/indexStore.js";

const MEMORY_ACTIONS = ["record", "recall", "read", "validate"] as const;
const MEMORY_KINDS = ["sop", "fact"] as const;
const MEMORY_SCOPES = ["origin", "task", "project"] as const;
const MEMORY_READ_MODES = ["text", "json"] as const;

function memoryErrorResult(error: unknown) {
	const normalized = compactError(error);
	return jsonToolResult({
		action: "error",
		ok: false,
		error_code: normalized.code,
		message: normalized.message,
		error: normalized.message,
		diagnostics: normalized.diagnostics,
		recovery: normalized.recovery,
	}, { browserSessionId: undefined, detailLevel: undefined, outputPath: undefined, maxChars: 8_000 }, undefined, {
		toolName: "browser_memory",
		fallbackName: "browser-memory-error.json",
	});
}

export function registerMemoryTool({ pi, ensureStarted, memoryEvidenceResolver }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_memory",
		label: "Browser Memory",
		description: "Record, recall, read, or validate local browser memory entries. Recall is automatic for browser_observe scan/text through envelope.memory with verification status; record remains explicit, local-only, deduped, and evidence-backed when evidence is supplied.",
		promptSnippet: "Record durable browser memory entries; browser_observe automatically surfaces matched memory in envelope.memory, while recall/read remain available for manual follow-up.",
		promptGuidelines: [
			"Use browser_memory record only after a task succeeded. Durable evidence such as saved.path, browser-result://, or a non-stale snapshot with saved artifact is recommended provenance, and any evidenceRefs you provide must resolve successfully. Recording auto-dedups near-identical SOPs and returns duplicateCandidates for merely-similar ones — supersede those instead of piling up copies. If a recalled SOP no longer works, just record a corrected version; it supersedes the old one.",
			"browser_observe scan/text automatically surfaces matched memory in envelope.memory with verification fresh|unverified|stale; use browser_memory read when an envelope.memory handle needs the full body, or recall for manual cross-scope queries.",
			"browser_memory is local-only under .pi/browser-memory/; local scopes origin|task|project are supported, but v1 does not export/promote to repo.",
		],
		parameters: strictToolParameters({
			action: Type.Union(MEMORY_ACTIONS.map((value) => Type.Literal(value)), { description: "record | recall | read | validate" }),
			kind: enumParam(MEMORY_KINDS, "record/validate only: sop | fact"),
			scopeKind: enumParam(MEMORY_SCOPES, "record/validate only: origin | task | project."),
			scopeKey: Type.Optional(Type.String({ description: "Origin scope key, or omit and provide url for normalization." })),
			url: Type.Optional(Type.String({ description: "Optional absolute URL used to normalize origin scope for record/recall/validate." })),
			query: Type.Optional(Type.String({ description: "Optional recall query matched against title/triggers." })),
			title: Type.Optional(Type.String({ description: "record/validate only: memory entry title." })),
			triggers: Type.Optional(Type.Array(Type.String(), { description: "record/validate only: non-empty trigger phrases." })),
			body: Type.Optional(Type.String({ description: "record/validate only: HOW-only body. SOP <=120 lines, fact <=160 lines." })),
			evidenceRefs: Type.Optional(Type.Array(Type.Union([
				Type.String(),
				Type.Object({ kind: Type.Literal("artifact"), path: Type.String() }, { additionalProperties: true }),
				Type.Object({ kind: Type.Literal("browser-result"), uri: Type.String() }, { additionalProperties: true }),
				Type.Object({ kind: Type.Literal("snapshot"), snapshotId: Type.String() }, { additionalProperties: true }),
				Type.Object({ kind: Type.Literal("operation"), operationId: Type.String() }, { additionalProperties: true }),
			]), { description: "record/validate only: optional provenance evidence refs; provided refs must resolve successfully, and browser-result:// requires MCP resolver injection." })),
			id: Type.Optional(Type.String({ description: "read only: entry id." })),
			uri: Type.Optional(Type.String({ description: "read only: browser-memory:// URI." })),
			mode: Type.Optional(Type.Union(MEMORY_READ_MODES.map((value) => Type.Literal(value)), { description: "read only: text | json" })),
			offset: Type.Optional(Type.Number({ description: "read text mode: starting line (1-indexed)." })),
			limit: Type.Optional(Type.Number({ description: "read text/json mode: line or item limit." })),
			jsonPath: Type.Optional(Type.String({ description: "read only: optional jsonPath; when provided without mode, read defaults to json." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const action = String(params.action || "").trim().toLowerCase();
				const maxChars = toolMaxChars(params, "browser_memory");
				if (!MEMORY_ACTIONS.includes(action as typeof MEMORY_ACTIONS[number])) throw createCodedError({ name: "MemoryActionError", code: "MEMORY_ACTION_UNSUPPORTED", message: `Unsupported browser_memory action: ${params.action}` });
				if (action === "read") {
					const result = await readBrowserMemory({ cwd: ctx?.cwd, id: params.id, uri: params.uri, mode: params.mode as MemoryReadMode | undefined, offset: params.offset, limit: params.limit, jsonPath: params.jsonPath });
					return await jsonToolResult({ action: "read", ...result, id: params.id, uri: params.uri }, { browserSessionId: undefined, detailLevel: undefined, outputPath: undefined, maxChars, redact: undefined }, ctx, { toolName: "browser_memory", fallbackName: "browser-memory-read.json" });
				}
				if (action === "recall") {
					const cards = await recallMemory({ cwd: ctx?.cwd, scopeKind: params.scopeKind, scopeKey: params.scopeKey, url: params.url, query: params.query });
					return await jsonToolResult({ action: "recall", scopeKind: params.scopeKind, scopeKey: params.scopeKey, query: params.query, cards }, { browserSessionId: undefined, detailLevel: undefined, outputPath: undefined, maxChars, redact: undefined }, ctx, { toolName: "browser_memory", fallbackName: "browser-memory-recall.json" });
				}
				const payload: MemoryRecordPayload = {
					kind: params.kind as "sop" | "fact",
					scopeKind: params.scopeKind,
					scopeKey: params.scopeKey,
					url: params.url,
					title: String(params.title || ""),
					triggers: Array.isArray(params.triggers) ? params.triggers : [],
					body: String(params.body || ""),
					evidenceRefs: Array.isArray(params.evidenceRefs) ? params.evidenceRefs : [],
					confidence: "verified",
				};
				const server = await ensureStarted().catch(() => undefined);
				if (action === "validate") {
					const validated = await validateMemoryRecord({ cwd: ctx?.cwd, server, resolver: memoryEvidenceResolver, payload });
					return await jsonToolResult({ action: "validate", ok: true, scopeKind: validated.entry.scopeKind, scopeKey: validated.scopeKey, entry: validated.entry, supersedeCandidates: validated.existingIds, duplicateCandidates: validated.duplicateCandidates }, { browserSessionId: undefined, detailLevel: undefined, outputPath: undefined, maxChars, redact: undefined }, ctx, { toolName: "browser_memory", fallbackName: "browser-memory-validate.json" });
				}
				const recorded = await recordMemoryEntry({ cwd: ctx?.cwd, server, resolver: memoryEvidenceResolver, payload });
				return await jsonToolResult({ action: "record", ok: true, scopeKind: recorded.entry.scopeKind, scopeKey: recorded.entry.scopeKey, entry: recorded.entry, id: recorded.entry.id, uri: browserMemoryUriForEntry(recorded.entry), supersededIds: recorded.supersededIds, duplicateCandidates: recorded.duplicateCandidates, index: { generatedAt: recorded.index.generatedAt, entryCount: recorded.index.entries.length } }, { browserSessionId: undefined, detailLevel: undefined, outputPath: undefined, maxChars, redact: undefined }, ctx, { toolName: "browser_memory", fallbackName: "browser-memory-record.json" });
			}, async (error) => await memoryErrorResult(error));
		},
	});
}
