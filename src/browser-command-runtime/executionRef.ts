import type { RefDescriptor } from "../kernels/refs/types.js";
import type { PageIdentity } from "../kernels/session/pageIdentity.js";
import { resolveRefUriDetailed } from "../resources/resourceRefs.js";
import { BrowserBridgeError } from "../utils/errors.js";

export const MAX_EXECUTION_REFS = 32;

export type ExecutionRefTarget = {
	refId: string;
	kind: RefDescriptor["kind"];
	fresh: boolean;
	owner: RefDescriptor["owner"];
	policy: RefDescriptor["policy"];
	semantic?: RefDescriptor["semantic"];
	pageIdentity?: PageIdentity;
	backendNodeId?: number;
	targetId?: string;
	point?: { x: number; y: number };
	visual?: RefDescriptor["visual"];
	locators: RefDescriptor["locators"];
};

function pageIdentity(descriptor: RefDescriptor): PageIdentity | undefined {
	const { browserSessionId, tabId } = descriptor.owner;
	const { targetGeneration, pageEpoch, url } = descriptor.documentEpoch ?? {};
	return browserSessionId && tabId && targetGeneration && pageEpoch
		? { browserSessionId, tabId, targetGeneration, pageEpoch, url: url ?? "" }
		: undefined;
}

function executionTarget(descriptor: RefDescriptor, fresh: boolean): ExecutionRefTarget {
	const backend = descriptor.locators.find((locator) => locator.by === "backendNodeId");
	const backendNodeId = backend?.by === "backendNodeId" && Number.isFinite(Number(backend.value)) ? Number(backend.value) : undefined;
	const targetId = descriptor.owner.targetId || (backend?.by === "backendNodeId" ? backend.targetId : undefined);
	const point = descriptor.geometry?.point;
	return {
		refId: descriptor.refId,
		kind: descriptor.kind,
		fresh,
		owner: descriptor.owner,
		policy: descriptor.policy,
		semantic: descriptor.semantic,
		pageIdentity: pageIdentity(descriptor),
		...(backendNodeId !== undefined ? { backendNodeId } : {}),
		...(targetId ? { targetId } : {}),
		...(point ? { point: { x: point.x, y: point.y } } : {}),
		...(descriptor.visual ? { visual: descriptor.visual } : {}),
		locators: descriptor.locators,
	};
}

export function resolveExecutionRef(uri: string): { descriptor: RefDescriptor; target: ExecutionRefTarget } {
	const resolved = resolveRefUriDetailed(uri);
	if (!resolved.ok) throw new BrowserBridgeError(resolved.code, resolved.error, { ref: uri });
	const descriptor = resolved.ref.descriptor;
	return { descriptor, target: executionTarget(descriptor, resolved.ref.fresh !== false) };
}
