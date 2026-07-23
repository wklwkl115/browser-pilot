import { defaultRefPolicyForKind } from "../refs/refPolicy.js";
import { finiteNumber as numberValue, isRecord, nonEmptyString as stringValue } from "../../utils/records.js";
import { urlOrigin } from "../../utils/url.js";
import type { Entity } from "./entity.js";
import type { CaptureRef, CaptureState, RefDescriptor } from "./types.js";

export type CaptureRefContext = {
	browserSessionId?: string;
	tabId?: number;
	observationId: string;
	capturedAt: number;
	url?: string;
};

export function createCaptureRef(params: {
	refId: string;
	state: CaptureState;
	startedAt: number;
	stoppedAt?: number;
	expiresAt: number;
	lastSeq?: number;
	context: CaptureRefContext;
}): CaptureRef {
	const capturedAt = params.context.capturedAt;
	return {
		refId: params.refId,
		kind: "signal",
		locators: [],
		owner: {
			...(params.context.browserSessionId ? { browserSessionId: params.context.browserSessionId } : {}),
			...(params.context.tabId !== undefined ? { tabId: params.context.tabId } : {}),
			...(urlOrigin(params.context.url) ? { topLevelOrigin: urlOrigin(params.context.url) } : {}),
		},
		policy: defaultRefPolicyForKind("signal"),
		observationId: params.context.observationId,
		documentEpoch: { url: params.context.url, capturedAt },
		createdAt: capturedAt,
		ttlMs: Math.max(1, params.expiresAt - capturedAt),
		streamState: {
			state: params.state,
			startedAt: params.startedAt,
			...(params.stoppedAt !== undefined ? { stoppedAt: params.stoppedAt } : {}),
			expiresAt: params.expiresAt,
			...(params.lastSeq !== undefined ? { lastSeq: params.lastSeq } : {}),
		},
	};
}

export function buildNetworkEntryEntity(entry: Record<string, unknown>, context: CaptureRefContext): { entity: Omit<Entity, "ref">; descriptor: Omit<RefDescriptor, "refId"> } {
	const request = isRecord(entry.request) ? entry.request : {};
	const response = isRecord(entry.response) ? entry.response : {};
	const url = stringValue(entry.url) || stringValue(request.url);
	const method = stringValue(entry.method) || stringValue(request.method);
	const status = numberValue(entry.status) ?? numberValue(response.status);
	const capturedAt = context.capturedAt;
	const bodyHandle = stringValue(entry.bodyRef) || stringValue(entry._bodyRef);
	const requestId = stringValue(entry.requestId) || stringValue(entry._requestId) || stringValue(entry.id) || "network-entry";
	const entity: Omit<Entity, "ref"> = {
		kind: "network-entry",
		role: "request",
		name: `${method || "GET"} ${url || requestId}`,
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "network",
		stream: {
			at: numberValue(entry.updatedAt) ?? numberValue(entry.createdAt) ?? capturedAt,
			...(method ? { method } : {}),
			...(url ? { url } : {}),
			...(status !== undefined ? { status } : {}),
			...(bodyHandle ? { payloadHandle: bodyHandle } : {}),
		},
		hints: {
			requestId,
			jsonPath: undefined,
			bodyAvailability: stringValue(entry.bodyAvailability) || stringValue(entry._bodyAvailability),
			bodyUnavailableReason: stringValue(entry.bodyUnavailableReason) || stringValue(entry._bodyUnavailableReason),
		},
	};
	return {
		entity,
		descriptor: {
			kind: "network-entry",
			locators: [],
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(urlOrigin(url || context.url) ? { topLevelOrigin: urlOrigin(url || context.url) } : {}),
			},
			policy: defaultRefPolicyForKind("network-entry"),
			snapshot: bodyHandle ? { observationId: context.observationId, resourceUri: bodyHandle, immutable: true } : undefined,
			semantic: { role: "request", ...(method ? { name: `${method} ${url || requestId}` } : {}) },
			observationId: context.observationId,
			documentEpoch: { url: url || context.url, capturedAt },
			createdAt: capturedAt,
			ttlMs: 60 * 60 * 1000,
		},
	};
}

export function buildEventEntity(event: Record<string, unknown>, context: CaptureRefContext): { entity: Omit<Entity, "ref">; descriptor: Omit<RefDescriptor, "refId"> } {
	const eventType = stringValue(event.type) || stringValue(event.event) || stringValue(event.eventType) || "event";
	const phase = stringValue(event.phase) || stringValue(event.kind);
	const payloadHandle = stringValue(event.payloadHandle) || stringValue(event.handle) || stringValue(event.bodyRef);
	const at = numberValue(event.timestamp) ?? numberValue(event.t) ?? numberValue(event.at) ?? context.capturedAt;
	const summaryText = stringValue(event.summary) || stringValue(event.message) || stringValue(event.preview);
	const entity: Omit<Entity, "ref"> = {
		kind: "event",
		role: "event",
		name: eventType,
		...(summaryText ? { value: summaryText } : {}),
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "hook",
		stream: {
			at,
			eventType,
			...(phase ? { phase } : {}),
			...(payloadHandle ? { payloadHandle } : {}),
		},
		hints: {
			jsonPath: undefined,
			originRef: stringValue(event.originRef),
		},
	};
	return {
		entity,
		descriptor: {
			kind: "event",
			locators: [],
			owner: {
				...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
				...(context.tabId !== undefined ? { tabId: context.tabId } : {}),
				...(urlOrigin(context.url) ? { topLevelOrigin: urlOrigin(context.url) } : {}),
			},
			policy: defaultRefPolicyForKind("event"),
			snapshot: payloadHandle ? { observationId: context.observationId, resourceUri: payloadHandle, immutable: true } : undefined,
			semantic: { role: eventType, ...(summaryText ? { value: summaryText } : {}) },
			observationId: context.observationId,
			documentEpoch: { url: context.url, capturedAt: at },
			createdAt: at,
			ttlMs: 60 * 60 * 1000,
		},
	};
}
