/**
 * MCP ingress handle/ref resolver.
 *
 * Resolves browser-result:// and pi-ref:// handle strings in tool arguments to
 * their typed JSON payloads before TypeBox validation runs. This is the
 * two-stage validation pipeline:
 *
 *   1. Detect handle strings in declared handle-accepting fields.
 *   2. Resolve resource/ref: kind/etag/ttl/session/redaction checks.
 *   3. Read and parse the artifact JSON.
 *   4. Return expanded args — TypeBox validation runs on the expansion.
 *
 * Invariants:
 * - Only declared handle-accepting fields are resolved (HANDLE_ACCEPTING_FIELDS side-table).
 * - kind mismatch, expired, not found, redaction conflict all return structured errors.
 * - Diagnostics include handle meta but NOT the payload content.
 * - Handle/ref resolution CANNOT auto-select targets or chain to other tools.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decideRefAccess } from "../src/abml/refPolicy.js";
import { normalizeAbmlError } from "../src/abml/errors.js";
import { redactSensitiveValue } from "../src/utils/redaction.js";
import { resolveRefUriDetailed, RESOURCE_URI_SCHEME, PI_REF_URI_SCHEME } from "./resourceStore.js";
import { HANDLE_ACCEPTING_FIELDS } from "./handleFields.js";
import { getJsonPath } from "./jsonPath.js";
import type { ResourceKind } from "./resourceStore.js";

export type HandleResolutionResult =
	| { ok: true; args: Record<string, unknown>; diagnostics: Record<string, unknown>[] }
	| { ok: false; error: string; code: string };

/** Return true if a value looks like a browser-result:// or pi-ref:// handle string. */
function isHandleString(value: unknown): value is string {
	return typeof value === "string"
		&& (value.startsWith(`${RESOURCE_URI_SCHEME}://`) || value.startsWith(`${PI_REF_URI_SCHEME}://`));
}

/**
 * Resolve any handle strings in declared fields of `args` for the given tool.
 * Returns expanded args with handles replaced by their resolved JSON payloads.
 * Returns an error if any handle fails to resolve.
 */
export async function resolveIngressHandles(
	toolName: string,
	args: Record<string, unknown>,
): Promise<HandleResolutionResult> {
	const declarations = HANDLE_ACCEPTING_FIELDS[toolName];
	if (!declarations || declarations.length === 0) {
		return { ok: true, args, diagnostics: [] };
	}

	const expanded: Record<string, unknown> = { ...args };
	const diagnostics: Record<string, unknown>[] = [];

	for (const decl of declarations) {
		const value = args[decl.field];
		if (!isHandleString(value)) continue;

		const uri = value;
		const resolved = resolveRefUriDetailed(uri);
		if (!resolved.ok) {
			return {
				ok: false,
				error: resolved.error,
				code: resolved.code,
			};
		}
		const record = resolved.ref;

		if (record.resourceKind !== decl.expectKind) {
			return {
				ok: false,
				error: `Handle kind mismatch: expected ${decl.expectKind}, got ${record.resourceKind || record.descriptor.kind} for ${uri}`,
				code: "HANDLE_KIND_MISMATCH",
			};
		}

		if (!record.artifactPath) {
			return {
				ok: false,
				error: `Handle is not backed by a readable artifact: ${uri}`,
				code: "HANDLE_NOT_FOUND",
			};
		}

		const sameSessionContext = {
			browserSessionId: typeof args.browserSessionId === "string" ? args.browserSessionId : (record.browserSessionId ?? record.descriptor.owner.browserSessionId),
			tabId: typeof args.tabId === "number" ? args.tabId : record.descriptor.owner.tabId,
			topLevelOrigin: record.descriptor.owner.topLevelOrigin,
			now: Date.now(),
			requestedRedaction: "default" as const,
			explicitSensitiveAccess: false,
		};
		const access = decideRefAccess(record.descriptor, sameSessionContext, {
			resourceFound: true,
			resourceExpired: false,
			// http-request section refs rely on selected-slice content hash; unrelated
			// whole-artifact etag drift must not fail them before slice-hash verification.
			etagMatches: record.hash ? true : record.fresh !== false,
			sensitive: record.redaction === "disabled",
		});
		if (!access.ok) {
			const abml = normalizeAbmlError({ code: access.code, message: access.reason });
			return {
				ok: false,
				error: abml.message,
				code: abml.code,
			};
		}

		// Read and parse the artifact as JSON
		let payload: unknown;
		try {
			const raw = await readFile(record.artifactPath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			const selected = record.jsonPath ? getJsonPath(parsed, record.jsonPath) : { exists: true, value: parsed };
			if (!selected.exists) {
				return {
					ok: false,
					error: `Handle jsonPath not found: ${record.jsonPath || "$"}`,
					code: "HANDLE_READ_ERROR",
				};
			}

			// Staleness / integrity: the artifact under this handle must match what
			// was captured at registration. For http-request templates we recorded a
			// content sha256; section resources hash the selected jsonPath slice so
			// unrelated raw artifact changes do not invalidate a stable request handle.
			if (record.hash) {
				const actual = createHash("sha256").update(JSON.stringify(selected.value)).digest("hex");
				if (actual !== record.hash) {
					return {
						ok: false,
						error: `Handle content changed since capture (etag/hash mismatch): ${uri}`,
						code: "HANDLE_ETAG_MISMATCH",
					};
				}
			} else if (record.fresh === false) {
				return {
					ok: false,
					error: `Handle content changed since capture (etag mismatch): ${uri}`,
					code: "HANDLE_ETAG_MISMATCH",
				};
			}

			// Unwrap DistilledEnvelope if present — use raw value or inner data
			if (selected.value != null && typeof selected.value === "object" && !Array.isArray(selected.value)) {
				const rec = selected.value as Record<string, unknown>;
				payload = rec.data ?? rec.request ?? rec.value ?? selected.value;
			} else {
				payload = selected.value;
			}
			if (access.mode === "redacted") payload = redactSensitiveValue(payload);
		} catch (err) {
			return {
				ok: false,
				error: `Failed to read handle artifact: ${String(err)}`,
				code: "HANDLE_READ_ERROR",
			};
		}

		expanded[decl.field] = payload;

		// Echo handle diagnostics — NOT the payload content
		diagnostics.push({
			handle: uri,
			kind: record.resourceKind,
			jsonPath: record.jsonPath,
			etag: record.etag,
			createdAt: record.createdAt,
			bytes: record.bytes,
			resolved: true,
			redaction: access.mode === "redacted" ? "default" : "disabled",
		});
	}

	return { ok: true, args: expanded, diagnostics };
}

/** Check if any handle-accepting field in args contains a handle string. */
export function hasIngressHandles(toolName: string, args: Record<string, unknown>): boolean {
	const declarations = HANDLE_ACCEPTING_FIELDS[toolName];
	if (!declarations) return false;
	return declarations.some((decl) => isHandleString(args[decl.field]));
}

/** Return the resource kind expected for a given tool field. */
export function getExpectedHandleKind(toolName: string, field: string): ResourceKind | undefined {
	const declarations = HANDLE_ACCEPTING_FIELDS[toolName];
	return declarations?.find((d) => d.field === field)?.expectKind;
}
