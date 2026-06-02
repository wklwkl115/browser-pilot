import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { isRecord } from "../../utils/records.js";
import { assertBridgeCommandSucceeded } from "../../tools/bridgeResultValidation.js";
import { registerRefDescriptor } from "../../resources/resourceStore.js";
import type { Entity } from "../entity.js";
import { axName, axNodeId, axRole, buildAxEntityFromNode, boxModelToGeometry, isInterestingAxNode, mergeDomAndAxEntities, type AxContext } from "../ax.js";
import type { BuiltEntity } from "../entity.js";

export type AbmlAxRuntimeServer = Pick<BrowserBridgeServer, "sendCommand">;

export type AxReadRuntimeOptions = {
	browserSessionId?: string;
	tabId: number;
	observationId: string;
	url?: string;
	capturedAt?: number;
	timeoutMs?: number;
};

async function sendPersistentCdp(server: AbmlAxRuntimeServer, options: { browserSessionId?: string; tabId: number; timeoutMs: number; cdpMethod: string; params?: Record<string, unknown> }) {
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

function valueRecord(result: unknown): Record<string, unknown> {
	if (isRecord(result)) return result;
	return {};
}

// Container roles that meaningfully "own" their members (item↔list, cell↔row↔table,
// radio↔radiogroup). Walking the AX childIds graph upward to the nearest one gives each
// member entity its structural container — the relationship arm of the ARIA spectrum.
const CONTAINER_ROLES = new Set(["radiogroup", "group", "list", "listbox", "menu", "menubar", "table", "grid", "treegrid", "tree", "tablist", "row", "rowgroup", "feed"]);

export function nearestContainer(node: Record<string, unknown>, parentByChildId: Map<string, Record<string, unknown>>): { role: string; name: string | undefined } | undefined {
	let current = node;
	for (let depth = 0; depth < 24; depth += 1) {
		const id = axNodeId(current);
		if (!id) return undefined;
		const parent = parentByChildId.get(id);
		if (!parent) return undefined;
		const role = axRole(parent).toLowerCase();
		if (CONTAINER_ROLES.has(role)) return { role, name: axName(parent) };
		current = parent;
	}
	return undefined;
}

export async function readAxEntities(server: AbmlAxRuntimeServer, options: AxReadRuntimeOptions): Promise<BuiltEntity[]> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const tree = await sendPersistentCdp(server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs,
		cdpMethod: "Accessibility.getFullAXTree",
	});
	const root = valueRecord(tree.data);
	const rootResult = valueRecord(root.result);
	const nodes = Array.isArray(root.nodes) ? root.nodes as Array<Record<string, unknown>> : Array.isArray(rootResult.nodes) ? rootResult.nodes as Array<Record<string, unknown>> : [];
	const context: AxContext = {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		url: options.url,
		observationId: options.observationId,
		capturedAt: options.capturedAt,
	};
	const parentByChildId = new Map<string, Record<string, unknown>>();
	for (const node of nodes) {
		const childIds = Array.isArray(node.childIds) ? node.childIds : [];
		for (const childId of childIds) {
			const key = typeof childId === "string" ? childId : String(childId);
			if (key) parentByChildId.set(key, node);
		}
	}
	const out: BuiltEntity[] = [];
	for (const node of nodes) {
		if (!isInterestingAxNode(node)) continue;
		const backendNodeId = Number(node.backendDOMNodeId ?? node.backendNodeId);
		let geometry: ReturnType<typeof boxModelToGeometry> | undefined;
		if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
			try {
				const box = await sendPersistentCdp(server, {
					browserSessionId: options.browserSessionId,
					tabId: options.tabId,
					timeoutMs,
					cdpMethod: "DOM.getBoxModel",
					params: { backendNodeId },
				});
				geometry = boxModelToGeometry(valueRecord(box.data).result ?? valueRecord(box.data));
			} catch {
				geometry = undefined;
			}
		}
		const built = buildAxEntityFromNode(node, context, geometry);
		const container = nearestContainer(node, parentByChildId);
		if (container) built.entity.hints = { ...(built.entity.hints || {}), containerRole: container.role, ...(container.name ? { containerName: container.name } : {}) };
		out.push(built);
	}
	return out;
}

export function mergeAxIntoDomEntities(domEntities: Entity[], axEntities: BuiltEntity[]): Entity[] {
	const merged = mergeDomAndAxEntities(domEntities, axEntities);
	const appended = merged.unmatchedAx.map((item) => {
		const refId = registerRefDescriptor({ descriptor: item.descriptor, name: item.entity.name || item.entity.role });
		return { ...item.entity, ref: refId };
	});
	return [...merged.merged, ...appended];
}
