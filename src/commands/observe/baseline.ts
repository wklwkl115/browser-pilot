import { readFile } from "node:fs/promises";
import type { Entity } from "../../kernels/abml/entity.js";
import { BrowserBridgeError } from "../../utils/errors.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { isRecord } from "../../utils/records.js";
import type { PageIdentity } from "../../kernels/session/pageIdentity.js";
import { isPageObservationV3 } from "../../validation/pageContracts.js";
import { pageIdentityFromUnknown } from "./pageIdentity.js";

export function mergeEntitiesByRef(...groups: unknown[][]): Entity[] {
	const seen = new Set<string>();
	const out: Entity[] = [];
	for (const group of groups) {
		for (const item of group) {
			if (!isRecord(item) || typeof item.ref !== "string" || !isRecord(item.state) || seen.has(item.ref)) continue;
			seen.add(item.ref);
			out.push(item as Entity);
		}
	}
	return out;
}

export function entityRefs(entities: Entity[], limit = Number.MAX_SAFE_INTEGER): string[] {
	return entities.map((entity) => entity.ref).filter((ref): ref is string => typeof ref === "string" && !!ref).slice(0, limit);
}

export type BaselineResolution = { entities: Entity[]; partialBaseline: boolean; networkSeq?: number; hookSeq?: number; snapshotId?: string; pageIdentity?: PageIdentity };

function baselineRecovery(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...extra,
		recovery: {
			retryable: true,
			hint: "Run browser_observe once to establish fresh state, then retry with diff:true.",
			nextActions: ["browser_observe", "browser_observe diff:true"],
		},
	};
}

export async function resolveBaselineEntities(server: BrowserCommandRuntimePort, snapshotId: string | undefined, signal?: AbortSignal): Promise<BaselineResolution | undefined> {
	if (!snapshotId) return undefined;
	const snapshot = server.getObservationSnapshot(snapshotId);
	if (!snapshot || snapshot.expired) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot is unavailable or expired", baselineRecovery({ snapshotId, expired: snapshot?.expired, invalidatedReason: snapshot?.invalidatedReason }));
	if (!snapshot.saved?.path) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot has no saved artifact path", baselineRecovery({ snapshotId }));
	let parsed: unknown;
	try {
		parsed = parseJsonOrThrow(await readFile(snapshot.saved.path, { encoding: "utf8", signal }), "browser_observe baseline snapshot artifact");
	} catch (error) {
		signal?.throwIfAborted();
		throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact could not be read as JSON", baselineRecovery({ snapshotId, path: snapshot.saved.path, error: error instanceof Error ? error.message : String(error) }));
	}
	if (!isPageObservationV3(parsed)) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact is not a canonical PageObservation", baselineRecovery({ snapshotId, path: snapshot.saved.path }));
	const fromArtifact = parsed.entities ?? [];
	return { entities: fromArtifact, partialBaseline: false, networkSeq: snapshot.networkSeq, hookSeq: snapshot.hookSeq, snapshotId, pageIdentity: pageIdentityFromUnknown(snapshot) ?? pageIdentityFromUnknown(parsed) };
}
