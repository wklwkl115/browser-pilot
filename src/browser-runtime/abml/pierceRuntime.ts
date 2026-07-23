import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { normalizeAbmlError } from "../../kernels/abml/errors.js";
import { buildAxEntityFromNode, boxModelToGeometry, isInterestingAxNode } from "../../kernels/abml/ax.js";
import { registerRefDescriptor, selectorFromRef, type ResourceRefDescriptor as RefDescriptor } from "../../resources/resourceRefs.js";
import { recordValue } from "../../utils/records.js";
import { readPartialAxTree, sendPersistentCdp, type PartialAxDiagnostics } from "./axRuntime.js";

export type AbmlPierceRuntimeServer = Pick<BrowserCommandRuntimePort, "sendCommand">;

function pointDistance(a?: { x: number; y: number }, b?: { x: number; y: number }): number | undefined {
	if (!a || !b) return undefined;
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function backendNodeIdFromRef(descriptor: RefDescriptor): number | undefined {
	for (const locator of descriptor.locators) {
		if (locator.by !== "backendNodeId") continue;
		const value = Number(locator.value);
		if (Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function localAxNodes(nodes: Array<Record<string, unknown>>, backendNodeId: number | undefined): Array<Record<string, unknown>> {
	if (backendNodeId === undefined) return [];
	const exact = nodes.filter((node) => Number(node.backendDOMNodeId ?? node.backendNodeId) === backendNodeId);
	return exact.length ? exact : nodes.slice(0, 1);
}

async function buildEntitiesFromAxNodes(server: AbmlPierceRuntimeServer, nodes: Array<Record<string, unknown>>, descriptor: RefDescriptor, options: { browserSessionId?: string; tabId: number; observationId: string; capturedAt: number; timeoutMs: number }, source: "partial-ax" | "ax", selector: string): Promise<Entity[]> {
	const targetPoint = descriptor.geometry?.point;
	const built: Entity[] = [];
	for (const node of nodes) {
		if (!isInterestingAxNode(node)) continue;
		const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
		let geometry: ReturnType<typeof boxModelToGeometry> | undefined;
		if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
			try {
				const box = await sendPersistentCdp(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, cdpMethod: "DOM.getBoxModel", params: { backendNodeId } });
				geometry = boxModelToGeometry(recordValue(box.data)?.result ?? recordValue(box.data));
			} catch {
				geometry = undefined;
			}
		}
		if (targetPoint && geometry?.point) {
			const dist = pointDistance(targetPoint, geometry.point);
			if (dist !== undefined && dist > 80) continue;
		}
		const builtAx = buildAxEntityFromNode(node, { browserSessionId: options.browserSessionId, tabId: options.tabId, observationId: options.observationId, capturedAt: options.capturedAt }, geometry);
		const refId = registerRefDescriptor({ descriptor: builtAx.descriptor });
		built.push({ ...builtAx.entity, ref: refId, source: "ax", hints: { ...(builtAx.entity.hints || {}), piercedFrom: descriptor.refId, selector, axRefinement: source } });
	}
	return built;
}

export async function pierceRefEntities(server: AbmlPierceRuntimeServer, descriptor: RefDescriptor, options: { browserSessionId?: string; tabId: number; observationId: string; capturedAt?: number; timeoutMs?: number }): Promise<{ ok: true; entities: Entity[]; data: Record<string, unknown> } | { ok: false; error: ReturnType<typeof normalizeAbmlError> }> {
	const selector = selectorFromRef(descriptor);
	if (!selector) return { ok: false, error: normalizeAbmlError({ code: "INVALID_INPUT", message: "ABML pierce currently requires a css locator" }) };
	const timeoutMs = options.timeoutMs ?? 10_000;
	const capturedAt = options.capturedAt ?? Date.now();
	const backendNodeId = backendNodeIdFromRef(descriptor);
	let partialAx: PartialAxDiagnostics | undefined;
	try {
		const partial = await readPartialAxTree(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, backendNodeId, timeoutMs: Math.min(timeoutMs, 1_500), maxNodes: 8, fetchRelatives: false });
		partialAx = partial.diagnostics;
		const partialEntities = await buildEntitiesFromAxNodes(server, localAxNodes(partial.nodes, backendNodeId), descriptor, { ...options, capturedAt, timeoutMs }, "partial-ax", selector);
		if (partialEntities.length) return { ok: true, entities: partialEntities.slice(0, 12), data: { selector, source: "partial-ax", entityCount: partialEntities.length, transport: "cdp-partial-ax", partialAx } };
		const tree = await sendPersistentCdp(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs, cdpMethod: "Accessibility.getFullAXTree" });
		const treeRoot = recordValue(tree.data);
		const treeResult = recordValue(treeRoot?.result);
		const nodes = Array.isArray(treeRoot?.nodes) ? treeRoot.nodes as Array<Record<string, unknown>> : Array.isArray(treeResult?.nodes) ? treeResult.nodes as Array<Record<string, unknown>> : [];
		const fullEntities = await buildEntitiesFromAxNodes(server, nodes, descriptor, { ...options, capturedAt, timeoutMs }, "ax", selector);
		return { ok: true, entities: fullEntities.slice(0, 12), data: { selector, source: "ax", entityCount: fullEntities.length, transport: "cdp-ax", partialAx } };
	} catch (error) {
		return { ok: false, error: normalizeAbmlError(error) };
	}
}
