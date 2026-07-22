import type { RefDescriptor } from "../kernels/refs/types.js";

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
