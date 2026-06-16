import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { assertBridgeCommandSucceeded } from "../../utils/bridgeResultValidation.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { normalizeAbmlError } from "../../kernels/abml/errors.js";
import { buildAxEntityFromNode, boxModelToGeometry, isInterestingAxNode } from "../../kernels/abml/ax.js";
import { registerRefDescriptor, type ResourceRefDescriptor as RefDescriptor } from "../../resources/resourceRefs.js";
import { recordValue } from "../../utils/records.js";

export type AbmlPierceRuntimeServer = Pick<BrowserCommandRuntimePort, "sendCommand">;

function selectorFromRef(descriptor: RefDescriptor): string | undefined {
	for (const locator of descriptor.locators) if (locator.by === "css" && locator.value.trim()) return locator.value;
	return undefined;
}

function pointDistance(a?: { x: number; y: number }, b?: { x: number; y: number }): number | undefined {
	if (!a || !b) return undefined;
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
}

async function sendPersistentCdp(server: AbmlPierceRuntimeServer, options: { browserSessionId?: string; tabId: number; timeoutMs: number; cdpMethod: string; params?: Record<string, unknown> }) {
	const result = await server.sendCommand({
		cmd: "persistent_cdp",
		action: "send",
		tabId: options.tabId,
		cdpMethod: options.cdpMethod,
		params: options.params || {},
		persistent: true,
		timeoutMs: options.timeoutMs,
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, `persistent_cdp:${options.cdpMethod}`);
	return result;
}

export async function pierceRefEntities(server: AbmlPierceRuntimeServer, descriptor: RefDescriptor, options: { browserSessionId?: string; tabId: number; observationId: string; capturedAt?: number; timeoutMs?: number }): Promise<{ ok: true; entities: Entity[]; data: Record<string, unknown> } | { ok: false; error: ReturnType<typeof normalizeAbmlError> }> {
	const selector = selectorFromRef(descriptor);
	if (!selector) return { ok: false, error: normalizeAbmlError({ code: "INVALID_INPUT", message: "ABML pierce currently requires a css locator" }) };
	const timeoutMs = options.timeoutMs ?? 10_000;
	const capturedAt = options.capturedAt ?? Date.now();
	try {
		const tree = await sendPersistentCdp(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs, cdpMethod: "Accessibility.getFullAXTree" });
		const treeRoot = recordValue(tree.data);
		const treeResult = recordValue(treeRoot?.result);
		const nodes = Array.isArray(treeResult?.nodes) ? treeResult.nodes as Array<Record<string, unknown>> : [];
		const targetPoint = descriptor.geometry?.point;
		const built: Entity[] = [];
		for (const node of nodes) {
			if (!isInterestingAxNode(node)) continue;
			const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
			let geometry: ReturnType<typeof boxModelToGeometry> | undefined;
			if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
				try {
					const box = await sendPersistentCdp(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs, cdpMethod: "DOM.getBoxModel", params: { backendNodeId } });
					geometry = boxModelToGeometry(recordValue(box.data)?.result ?? recordValue(box.data));
				} catch {
					geometry = undefined;
				}
			}
			if (targetPoint && geometry?.point) {
				const dist = pointDistance(targetPoint, geometry.point);
				if (dist !== undefined && dist > 80) continue;
			}
			const builtAx = buildAxEntityFromNode(node, { browserSessionId: options.browserSessionId, tabId: options.tabId, observationId: options.observationId, capturedAt }, geometry);
			const refId = registerRefDescriptor({ descriptor: builtAx.descriptor, resourceKind: "scan", name: builtAx.entity.name || builtAx.entity.role });
			built.push({ ...builtAx.entity, ref: refId, source: "ax", hints: { ...(builtAx.entity.hints || {}), piercedFrom: descriptor.refId, selector } });
		}
		return { ok: true, entities: built.slice(0, 12), data: { selector, source: "ax", entityCount: built.length, transport: "cdp-ax" } };
	} catch (error) {
		return { ok: false, error: normalizeAbmlError(error) };
	}
}
