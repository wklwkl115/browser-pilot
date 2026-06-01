import { registerRefDescriptor } from "../../../mcp/resourceStore.js";
import { assertBridgeCommandSucceeded } from "../../tools/bridgeResultValidation.js";
import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import type { Entity } from "../entity.js";
import { normalizeAbmlError } from "../errors.js";
import type { RefDescriptor } from "../types.js";
import { recordValue } from "../../utils/records.js";

export type AbmlFrameRuntimeServer = Pick<BrowserBridgeServer, "sendCommand">;

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}


function topLevelOrigin(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

export type FrameEntityRuntimeOptions = {
	browserSessionId?: string;
	tabId: number;
	observationId: string;
	capturedAt?: number;
	depth?: number;
};

export async function readFrameEntities(server: AbmlFrameRuntimeServer, options: FrameEntityRuntimeOptions): Promise<{ entities: Entity[]; frames: Array<Record<string, unknown>>; frameTree?: Record<string, unknown> }> {
	const result = await server.sendCommand({ cmd: "frame.list", tabId: options.tabId, options: options.depth !== undefined ? { depth: options.depth } : undefined, timeoutMs: 10_000 }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: 10_000 });
	assertBridgeCommandSucceeded(result, "frame.list");
	const data = recordValue(result.data) || {};
	const frames = Array.isArray(data.frames) ? data.frames.filter((item): item is Record<string, unknown> => !!recordValue(item)) : [];
	const capturedAt = options.capturedAt ?? Date.now();
	const entities = frames.map((frame, index) => {
		const frameId = stringValue(frame.frameId) || stringValue(frame.id) || `frame-${index}`;
		const url = stringValue(frame.url);
		const name = stringValue(frame.name) || url || frameId;
		const refId = registerRefDescriptor({
			descriptor: {
				kind: "frame",
				locators: [{ by: "attrSignature", value: { frameId, ...(url ? { url } : {}), ...(stringValue(frame.name) ? { name: String(frame.name) } : {}) } }],
				owner: { ...(options.browserSessionId ? { browserSessionId: options.browserSessionId } : {}), tabId: options.tabId, ...(topLevelOrigin(url) ? { topLevelOrigin: topLevelOrigin(url) } : {}) },
				policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
				semantic: { role: "frame", name, value: frameId },
				observationId: options.observationId,
				documentEpoch: { frameId, url, capturedAt },
				createdAt: capturedAt,
				ttlMs: 5 * 60 * 1000,
				stabilityScore: 0.55,
			},
			resourceKind: "scan",
			name,
		});
		return {
			ref: refId,
			kind: "frame",
			role: "frame",
			name,
			value: frameId,
			state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
			source: "dom",
			locators: [{ by: "attrSignature", value: { frameId, ...(url ? { url } : {}), ...(stringValue(frame.name) ? { name: String(frame.name) } : {}) } }],
			hints: {
				frameId,
				parentId: stringValue(frame.parentId),
				url,
				name: stringValue(frame.name),
				mimeType: stringValue(frame.mimeType),
				securityOrigin: stringValue(frame.securityOrigin),
			},
		} satisfies Entity;
	});
	return { entities, frames, frameTree: recordValue(data.frameTree) };
}

export function frameIdFromRef(descriptor: RefDescriptor): string | undefined {
	for (const locator of descriptor.locators) {
		if (locator.by === "attrSignature" && typeof locator.value.frameId === "string" && locator.value.frameId.trim()) return locator.value.frameId;
	}
	return descriptor.semantic?.value;
}

export async function probeFrameReachability(server: AbmlFrameRuntimeServer, options: { browserSessionId?: string; tabId: number; frameId: string; timeoutMs?: number }): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: ReturnType<typeof normalizeAbmlError> }> {
	try {
		const result = await server.sendCommand({ cmd: "frame.evaluate", tabId: options.tabId, frameId: options.frameId, expression: "({ href: location.href, title: document.title })", grantUniversalAccess: true, returnByValue: true, timeoutMs: options.timeoutMs ?? 8_000 }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs ?? 8_000 });
		assertBridgeCommandSucceeded(result, "frame.evaluate");
		const data = recordValue(result.data) || {};
		const payload = recordValue(data.result)?.value;
		return { ok: true, data: recordValue(payload) || {} };
	} catch (error) {
		const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code || "") : "";
		const message = error instanceof Error ? error.message : String(error || "");
		if (code === "FRAME_NOT_FOUND" || code === "FRAME_EVAL_FAILED" || /frame not found|cross[- ]origin|isolated world|requested frame/i.test(message)) {
			return { ok: false, error: normalizeAbmlError({ code: "CROSS_ORIGIN_BLOCKED", message: `Frame ${options.frameId} is not directly reachable for live evaluation` }) };
		}
		return { ok: false, error: normalizeAbmlError(error) };
	}
}
