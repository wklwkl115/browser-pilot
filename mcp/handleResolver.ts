/**
 * MCP ingress handle resolver.
 *
 * Resolves browser-result:// URI handle strings in tool arguments to their
 * typed JSON payloads before TypeBox validation runs. This is the "two-stage"
 * validation pipeline from the Phase 6 contract:
 *
 *   1. Detect handle strings in declared handle-accepting fields.
 *   2. Resolve resource: kind/etag/ttl/session/redaction checks.
 *   3. Read and parse the artifact JSON.
 *   4. Return expanded args — TypeBox validation runs on the expansion.
 *
 * Invariants:
 * - Only declared handle-accepting fields are resolved (HANDLE_ACCEPTING_FIELDS side-table).
 * - kind mismatch, expired, not found, redaction conflict all return structured errors.
 * - Diagnostics include handle meta but NOT the payload content.
 * - Handle resolution CANNOT auto-select targets or chain to other tools.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveResourceUri, isResourceFresh, RESOURCE_URI_SCHEME } from "./resourceStore.js";
import { HANDLE_ACCEPTING_FIELDS } from "./handleFields.js";
import type { ResourceKind } from "./resourceStore.js";

export type HandleResolutionResult =
	| { ok: true; args: Record<string, unknown>; diagnostics: Record<string, unknown>[] }
	| { ok: false; error: string; code: string };

/** Return true if a value looks like a browser-result:// URI handle string. */
function isHandleString(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(`${RESOURCE_URI_SCHEME}://`);
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
		const resource = resolveResourceUri(uri);

		if (!resource) {
			return {
				ok: false,
				error: `Handle not found or expired: ${uri}`,
				code: "HANDLE_NOT_FOUND",
			};
		}

		if (resource.kind !== decl.expectKind) {
			return {
				ok: false,
				error: `Handle kind mismatch: expected ${decl.expectKind}, got ${resource.kind} for ${uri}`,
				code: "HANDLE_KIND_MISMATCH",
			};
		}

		// Read and parse the artifact as JSON
		let payload: unknown;
		try {
			const raw = await readFile(resource.artifactPath, "utf8");

			// Staleness / integrity: the artifact under this handle must match what
			// was captured at registration. For http-request templates we recorded a
			// content sha256; verify it against the bytes we just read. If no hash was
			// available, fall back to the stat-based etag freshness check.
			if (resource.hash) {
				const actual = createHash("sha256").update(raw).digest("hex");
				if (actual !== resource.hash) {
					return {
						ok: false,
						error: `Handle content changed since capture (etag/hash mismatch): ${uri}`,
						code: "HANDLE_ETAG_MISMATCH",
					};
				}
			} else if (!isResourceFresh(resource)) {
				return {
					ok: false,
					error: `Handle content changed since capture (etag mismatch): ${uri}`,
					code: "HANDLE_ETAG_MISMATCH",
				};
			}

			const parsed = JSON.parse(raw) as unknown;
			// Unwrap DistilledEnvelope if present — use raw value or inner data
			if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
				const rec = parsed as Record<string, unknown>;
				// Prefer the raw request data if wrapped in an envelope
				payload = rec.data ?? rec.request ?? rec.value ?? parsed;
			} else {
				payload = parsed;
			}
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
			kind: resource.kind,
			etag: resource.etag,
			createdAt: resource.createdAt,
			bytes: resource.bytes,
			resolved: true,
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
