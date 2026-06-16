import { resolveRefUriDetailed } from "../resources/resourceRefs.js";
import type { ResourceRefDescriptor as RefDescriptor } from "../ports/ResourceRefStorePort.js";
import { BROWSER_PILOT_STDLIB_NAMES, scriptReferencesClick, stdlibPrelude } from "./executeStdlibPrelude.js";
import { isBrowserPilotRef } from "../kernels/refs/core.js";

const REF_CANDIDATE_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>{}\])]+/gi;

export type ExecuteStdlibInfo = {
	used: boolean;
	refsEmbedded: number;
	resolveMisses: string[];
	namespace: readonly string[];
	targetRefs?: ExecuteStdlibTargetRef[];
	warnings?: string[];
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
	targetId?: string;
	point?: { x: number; y: number };
	cssRoots: string[];
	locators?: RefDescriptor["locators"];
};

function shouldInjectStdlib(script: string): boolean {
	REF_CANDIDATE_PATTERN.lastIndex = 0;
	return /\bbrowserPilot\s*\./.test(script) || Array.from(script.matchAll(REF_CANDIDATE_PATTERN), (match) => match[0]).some(isBrowserPilotRef);
}

function collectRefUris(script: string): string[] {
	REF_CANDIDATE_PATTERN.lastIndex = 0;
	return Array.from(new Set(Array.from(script.matchAll(REF_CANDIDATE_PATTERN), (match) => match[0]).filter(isBrowserPilotRef)));
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

function backendTargetFromDescriptor(descriptor: RefDescriptor): { backendNodeId?: number; targetId?: string } {
	let backendNodeId: number | undefined;
	let targetId = typeof descriptor.owner?.targetId === "string" && descriptor.owner.targetId.trim() ? descriptor.owner.targetId.trim() : undefined;
	for (const locator of descriptor.locators) {
		if (locator.by !== "backendNodeId") continue;
		if (Number.isFinite(Number(locator.value))) backendNodeId = Number(locator.value);
		if (!targetId && typeof locator.targetId === "string" && locator.targetId.trim()) targetId = locator.targetId.trim();
		if (backendNodeId !== undefined) break;
	}
	return { backendNodeId, targetId };
}

function targetRefFromDescriptor(descriptor: RefDescriptor): ExecuteStdlibTargetRef {
	const point = descriptor.geometry?.point;
	const backendTarget = backendTargetFromDescriptor(descriptor);
	return {
		refId: descriptor.refId,
		observedAt: descriptor.documentEpoch?.capturedAt ?? descriptor.createdAt,
		observationId: descriptor.observationId,
		url: descriptor.documentEpoch?.url,
		mutationEpoch: descriptor.documentEpoch?.mutationEpoch,
		...(backendTarget.backendNodeId !== undefined ? { backendNodeId: backendTarget.backendNodeId } : {}),
		...(backendTarget.targetId ? { targetId: backendTarget.targetId } : {}),
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
	const enabled = options.enabled ?? process.env.BROWSER_PILOT_STDLIB !== "0";
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
			namespace: click ? BROWSER_PILOT_STDLIB_NAMES : BROWSER_PILOT_STDLIB_NAMES.filter((name) => name !== "click"),
			...(registry.targetRefs.length ? { targetRefs: registry.targetRefs } : {}),
			...(registry.misses.length ? { warnings: [`${registry.misses.length} ref(s) failed to resolve: [${registry.misses.join(", ")}] — script received null elements`] } : {}),
		},
	};
}
