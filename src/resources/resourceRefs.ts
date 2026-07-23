import { randomUUID } from "node:crypto";
import { parseRef } from "../kernels/refs/core.js";
import { makeBrowserPilotRefUri, stableRefIdForDescriptor } from "../kernels/refs/refId.js";
import type { RefDescriptor, RefKind } from "../kernels/refs/types.js";
import { computeEtag, isFreshEtag } from "../utils/fileFreshness.js";

export type ResourceRefDescriptor = RefDescriptor;

export type RegisteredRefRecord = {
	refId: string;
	descriptor: ResourceRefDescriptor;
	artifactPath?: string;
	etag?: string;
};

export type ResolvedRefRecord = RegisteredRefRecord & { fresh?: boolean };

export type ResolveRefResult =
	| { ok: true; ref: ResolvedRefRecord }
	| { ok: false; code: "HANDLE_NOT_FOUND" | "REF_STALE"; error: string };

export type RegisterRefDescriptorParams = {
	descriptor: Omit<ResourceRefDescriptor, "refId"> & { refId?: string };
	artifactPath?: string;
	etag?: string;
};

export function selectorFromRef(descriptor: ResourceRefDescriptor): string | undefined {
	for (const locator of descriptor.locators) if (locator.by === "css" && locator.value.trim()) return locator.value;
	return undefined;
}

const REF_STORE_MAX_ENTRIES = 10_000;
const PRUNE_EVERY_REGISTRATIONS = 128;
const refStore = new Map<string, RegisteredRefRecord>();
let registrationsSincePrune = 0;

function parseBrowserPilotRefUri(uri: string): { kind?: RefKind; id: string } | undefined {
	try {
		const parsed = parseRef(uri.split("?")[0] ?? uri);
		return { kind: parsed.kind as RefKind, id: parsed.id };
	} catch {
		return undefined;
	}
}

export function registerRefDescriptor(params: RegisterRefDescriptorParams): string {
	pruneExpiredAmortized();
	const refId = params.descriptor.refId || stableRefIdForDescriptor(params.descriptor) || makeBrowserPilotRefUri(params.descriptor.kind, randomUUID());
	const parsed = parseBrowserPilotRefUri(refId);
	if (!parsed) throw new Error(`Invalid bp-ref URI: ${refId}`);
	const descriptor: ResourceRefDescriptor = { ...params.descriptor, refId };
	const artifactPath = params.artifactPath;
	refStore.delete(parsed.id);
	refStore.set(parsed.id, {
		refId,
		descriptor,
		artifactPath,
		etag: params.etag ?? (artifactPath ? computeEtag(artifactPath) : descriptor.snapshot?.etag),
	});
	if (refStore.size > REF_STORE_MAX_ENTRIES) {
		const oldestId = refStore.keys().next().value;
		if (oldestId) refStore.delete(oldestId);
	}
	return refId;
}

export function resolveRefUriDetailed(uri: string): ResolveRefResult {
	const parsed = parseBrowserPilotRefUri(uri);
	if (!parsed) return { ok: false, code: "HANDLE_NOT_FOUND", error: "Unrecognized ref URI" };
	const record = refStore.get(parsed.id);
	if (!record) return { ok: false, code: "HANDLE_NOT_FOUND", error: "Ref not found" };
	if (Date.now() > record.descriptor.createdAt + record.descriptor.ttlMs) {
		refStore.delete(parsed.id);
		return { ok: false, code: "REF_STALE", error: "Ref expired" };
	}
	return {
		ok: true,
		ref: {
			...record,
			...(record.artifactPath ? { fresh: !record.etag || isFreshEtag(record.artifactPath, record.etag) } : {}),
		},
	};
}

function pruneExpiredAmortized(): void {
	registrationsSincePrune += 1;
	if (registrationsSincePrune < PRUNE_EVERY_REGISTRATIONS) return;
	const now = Date.now();
	for (const [id, record] of refStore) {
		if (now > record.descriptor.createdAt + record.descriptor.ttlMs) refStore.delete(id);
	}
	registrationsSincePrune = 0;
}
