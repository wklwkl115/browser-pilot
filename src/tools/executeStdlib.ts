import { resolveRefUriDetailed } from "../resources/resourceStore.js";
import type { RefDescriptor } from "../abml/types.js";
import { PI_STDLIB_NAMES, scriptReferencesClick, stdlibPrelude } from "./executeStdlibPrelude.js";

const PI_REF_PATTERN = /pi-ref:\/\/[A-Za-z0-9_-]+\/[^\s"'`<>{}\])]+/g;

export type ExecuteStdlibInfo = {
	used: boolean;
	refsEmbedded: number;
	resolveMisses: string[];
	namespace: readonly string[];
	targetRefs?: ExecuteStdlibTargetRef[];
};

export type PreparedExecuteScript = {
	script: string;
	stdlib?: ExecuteStdlibInfo;
};

export type ExecuteStdlibTargetRef = {
	refId: string;
	observedAt?: number;
	observationId?: string;
	url?: string;
	mutationEpoch?: number;
	backendNodeId?: number;
	point?: { x: number; y: number };
	cssRoots: string[];
	locators?: RefDescriptor["locators"];
};

function shouldInjectStdlib(script: string): boolean {
	PI_REF_PATTERN.lastIndex = 0;
	return /\bpi\s*\./.test(script) || PI_REF_PATTERN.test(script);
}

function collectRefUris(script: string): string[] {
	PI_REF_PATTERN.lastIndex = 0;
	return Array.from(new Set(Array.from(script.matchAll(PI_REF_PATTERN), (match) => match[0])));
}

function safeDescriptor(descriptor: RefDescriptor): RefDescriptor {
	return {
		refId: descriptor.refId,
		kind: descriptor.kind,
		locators: descriptor.locators || [],
		owner: descriptor.owner || {},
		policy: descriptor.policy,
		snapshot: descriptor.snapshot,
		semantic: descriptor.semantic,
		geometry: descriptor.geometry,
		observationId: descriptor.observationId,
		documentEpoch: descriptor.documentEpoch,
		createdAt: descriptor.createdAt,
		ttlMs: descriptor.ttlMs,
		stabilityScore: descriptor.stabilityScore,
	};
}

function boundedCssRoots(descriptor: RefDescriptor): string[] {
	const roots: string[] = [];
	for (const locator of descriptor.locators) {
		if (locator.by !== "css" || !locator.value.trim()) continue;
		roots.push(locator.value.trim());
		if (roots.length >= 8) break;
	}
	return roots;
}

function backendNodeIdFromDescriptor(descriptor: RefDescriptor): number | undefined {
	for (const locator of descriptor.locators) {
		if (locator.by === "backendNodeId" && Number.isFinite(Number(locator.value))) return Number(locator.value);
	}
	return undefined;
}

function targetRefFromDescriptor(descriptor: RefDescriptor): ExecuteStdlibTargetRef {
	const point = descriptor.geometry?.point;
	return {
		refId: descriptor.refId,
		observedAt: descriptor.documentEpoch?.capturedAt ?? descriptor.createdAt,
		observationId: descriptor.observationId,
		url: descriptor.documentEpoch?.url,
		mutationEpoch: descriptor.documentEpoch?.mutationEpoch,
		backendNodeId: backendNodeIdFromDescriptor(descriptor),
		...(point ? { point: { x: point.x, y: point.y } } : {}),
		cssRoots: boundedCssRoots(descriptor),
		locators: descriptor.locators,
	};
}

function buildRefRegistry(refUris: string[]): { registry: Record<string, unknown>; embedded: number; misses: string[]; targetRefs: ExecuteStdlibTargetRef[] } {
	const registry: Record<string, unknown> = {};
	const misses: string[] = [];
	const targetRefs: ExecuteStdlibTargetRef[] = [];
	for (const uri of refUris) {
		const resolved = resolveRefUriDetailed(uri);
		if (!resolved.ok) {
			misses.push(uri);
			registry[uri] = { ok: false, code: resolved.code, error: resolved.error };
			continue;
		}
		targetRefs.push(targetRefFromDescriptor(resolved.ref.descriptor));
		registry[uri] = {
			ok: true,
			fresh: resolved.ref.fresh !== false,
			descriptor: safeDescriptor(resolved.ref.descriptor),
		};
	}
	return { registry, embedded: refUris.length - misses.length, misses, targetRefs };
}

export function prepareExecuteStdlib(script: string, options: { enabled?: boolean } = {}): PreparedExecuteScript {
	const enabled = options.enabled ?? process.env.PI_BROWSER_STDLIB !== "0";
	if (!enabled || !shouldInjectStdlib(script)) return { script };
	const refUris = collectRefUris(script);
	const registry = buildRefRegistry(refUris);
	const click = scriptReferencesClick(script);
	return {
		script: `${stdlibPrelude(registry.registry, { click })}\n${script}`,
		stdlib: {
			used: true,
			refsEmbedded: registry.embedded,
			resolveMisses: registry.misses,
			namespace: click ? PI_STDLIB_NAMES : PI_STDLIB_NAMES.filter((name) => name !== "click"),
			...(registry.targetRefs.length ? { targetRefs: registry.targetRefs } : {}),
		},
	};
}
