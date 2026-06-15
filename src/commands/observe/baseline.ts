import { readFile } from "node:fs/promises";
import type { Entity } from "../../kernels/abml/entity.js";
import { BrowserBridgeError } from "../../bridge/protocol/errors.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { isRecord } from "../../utils/records.js";

function networkSeqFromBaseline(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.networkSeq === "number") return value.networkSeq;
	const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
	if (typeof snapshot?.networkSeq === "number") return snapshot.networkSeq;
	const correlation = isRecord(value.correlation) ? value.correlation : undefined;
	if (typeof correlation?.networkSeq === "number") return correlation.networkSeq;
	return undefined;
}

function hookSeqFromBaseline(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.hookSeq === "number") return value.hookSeq;
	const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
	if (typeof snapshot?.hookSeq === "number") return snapshot.hookSeq;
	const correlation = isRecord(value.correlation) ? value.correlation : undefined;
	if (typeof correlation?.hookSeq === "number") return correlation.hookSeq;
	return undefined;
}

function entityArrayFromUnknown(value: unknown): Entity[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entities = value.filter((item): item is Entity => isRecord(item) && typeof item.ref === "string" && isRecord(item.state));
	return entities.length ? entities : undefined;
}

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

function baselineEntitiesFromParam(value: unknown): Entity[] | undefined {
	const direct = entityArrayFromUnknown(value);
	if (direct) return direct;
	if (!isRecord(value)) return undefined;
	for (const key of ["entities", "primary_entities", "list_entities", "visual_regions", "referenced_entities"]) {
		const entities = entityArrayFromUnknown(value[key]);
		if (entities) return entities;
	}
	for (const key of ["summary", "focus", "abml", "abmlRead", "data"]) {
		const nested = baselineEntitiesFromParam(value[key]);
		if (nested) return nested;
	}
	const focus = isRecord(value.focus) ? value.focus : undefined;
	const collected = [
		...(Array.isArray(focus?.primary_entities) ? focus.primary_entities : []),
		...(Array.isArray(focus?.list_entities) ? focus.list_entities : []),
		...(Array.isArray(focus?.visual_regions) ? focus.visual_regions : []),
		...(Array.isArray(focus?.referenced_entities) ? focus.referenced_entities : []),
	];
	return entityArrayFromUnknown(collected);
}

function baselineSnapshotId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (!isRecord(value)) return undefined;
	for (const key of ["snapshotId", "baselineSnapshotId"]) {
		if (typeof value[key] === "string" && value[key]) return value[key].trim();
	}
	const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
	return typeof snapshot?.snapshotId === "string" && snapshot.snapshotId ? snapshot.snapshotId.trim() : undefined;
}

function savedArtifactPathFromBaseline(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const saved = isRecord(value.saved) ? value.saved : undefined;
	return typeof saved?.path === "string" && saved.path.trim() ? saved.path.trim() : undefined;
}

export type BaselineResolution = { entities: Entity[]; partialBaseline: boolean; networkSeq?: number; hookSeq?: number; snapshotId?: string };

function baselineRecovery(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...extra,
		recovery: {
			retryable: true,
			hint: "Re-capture the baseline with browser_observe mode=scan, then pass the fresh snapshotId or saved observe artifact as baseline.",
			nextActions: ["browser_observe mode=scan", "use the new snapshotId or saved artifact as baseline"],
		},
	};
}

function baselinePartialHint(value: unknown, entities: Entity[]): boolean {
	if (Array.isArray(value)) return entities.length < 10;
	if (!isRecord(value)) return false;
	if (entityArrayFromUnknown(value.entities)) return false;
	if (value.partialBaseline === true || value.partial === true) return true;
	const diffOptions = isRecord(value.diffOptions) ? value.diffOptions : undefined;
	if (diffOptions?.partialBaseline === true) return true;
	if (["primary_entities", "list_entities", "visual_regions", "referenced_entities"].some((key) => Array.isArray(value[key]))) return true;
	const focus = isRecord(value.focus) ? value.focus : undefined;
	return !!focus && ["primary_entities", "list_entities", "visual_regions", "referenced_entities"].some((key) => Array.isArray(focus[key]));
}

export async function resolveBaselineEntities(server: BrowserCommandRuntimePort, baseline: unknown): Promise<BaselineResolution | undefined> {
	if (baseline === undefined || baseline === null) return undefined;
	const savedPath = savedArtifactPathFromBaseline(baseline);
	if (savedPath) {
		let parsedSaved: unknown;
		try {
			parsedSaved = parseJsonOrThrow(await readFile(savedPath, "utf8"), "browser_observe baseline saved artifact");
		} catch (error) {
			throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline saved artifact could not be read as JSON", baselineRecovery({ path: savedPath, error: error instanceof Error ? error.message : String(error) }));
		}
		const fromSaved = baselineEntitiesFromParam(parsedSaved);
		if (!fromSaved) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline saved artifact does not contain ABML entities", baselineRecovery({ path: savedPath }));
		return { entities: fromSaved, partialBaseline: false, networkSeq: networkSeqFromBaseline(baseline) ?? networkSeqFromBaseline(parsedSaved), hookSeq: hookSeqFromBaseline(baseline) ?? hookSeqFromBaseline(parsedSaved), snapshotId: baselineSnapshotId(baseline) };
	}
	const inline = baselineEntitiesFromParam(baseline);
	if (inline) return { entities: inline, partialBaseline: baselinePartialHint(baseline, inline), networkSeq: networkSeqFromBaseline(baseline), hookSeq: hookSeqFromBaseline(baseline), snapshotId: baselineSnapshotId(baseline) };
	const snapshotId = baselineSnapshotId(baseline);
	if (!snapshotId) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline must be an entity list, prior scan summary/envelope, or snapshotId", baselineRecovery({ baselineType: typeof baseline }));
	const snapshot = server.getObservationSnapshot(snapshotId);
	if (!snapshot || snapshot.expired) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot is unavailable or expired", baselineRecovery({ snapshotId, expired: snapshot?.expired, invalidatedReason: snapshot?.invalidatedReason }));
	if (!snapshot.saved?.path) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot has no saved artifact path", baselineRecovery({ snapshotId }));
	let parsed: unknown;
	try {
		parsed = parseJsonOrThrow(await readFile(snapshot.saved.path, "utf8"), "browser_observe baseline snapshot artifact");
	} catch (error) {
		throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact could not be read as JSON", baselineRecovery({ snapshotId, path: snapshot.saved.path, error: error instanceof Error ? error.message : String(error) }));
	}
	const fromArtifact = baselineEntitiesFromParam(parsed);
	if (!fromArtifact) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact does not contain ABML entities", baselineRecovery({ snapshotId, path: snapshot.saved.path }));
	return { entities: fromArtifact, partialBaseline: false, networkSeq: typeof snapshot.networkSeq === "number" ? snapshot.networkSeq : networkSeqFromBaseline(parsed), hookSeq: typeof snapshot.hookSeq === "number" ? snapshot.hookSeq : hookSeqFromBaseline(parsed), snapshotId };
}
