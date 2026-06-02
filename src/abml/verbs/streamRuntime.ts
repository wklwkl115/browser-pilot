import { readBrowserResultResource } from "../../resources/resourceReader.js";
import { resolveRefUriDetailed } from "../../resources/resourceStore.js";
import { buildEventEntity, buildNetworkEntryEntity, createCaptureRef, mapCaptureState, type CaptureRefContext } from "../stream.js";
import type { CaptureRef, RefDescriptor } from "../types.js";
import { normalizeAbmlError } from "../errors.js";
import { recordValue } from "../../utils/records.js";

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function numberValue(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

export type CaptureLifecycleInput = {
	state?: unknown;
	startedAt?: unknown;
	stoppedAt?: unknown;
	expiresAt?: unknown;
	lastSeq?: unknown;
	refId: string;
	context: CaptureRefContext;
};

export function createCaptureRefFromLifecycle(input: CaptureLifecycleInput): CaptureRef {
	const startedAt = numberValue(input.startedAt) ?? input.context.capturedAt ?? Date.now();
	const expiresAt = numberValue(input.expiresAt) ?? (startedAt + 60 * 60 * 1000);
	return createCaptureRef({
		refId: input.refId,
		state: mapCaptureState(input.state, Date.now(), expiresAt),
		startedAt,
		stoppedAt: numberValue(input.stoppedAt),
		expiresAt,
		lastSeq: numberValue(input.lastSeq),
		context: input.context,
	});
}

export function inspectPayloadHandle(ref: RefDescriptor | string): Promise<{ ok: true; content: { uri: string; mimeType?: string; text: string } } | { ok: false; error: ReturnType<typeof normalizeAbmlError> }> {
	const resolved = typeof ref === "string" ? resolveRefUriDetailed(ref) : { ok: true as const, ref: { descriptor: ref } as { descriptor: RefDescriptor } };
	if (!resolved.ok) return Promise.resolve({ ok: false, error: normalizeAbmlError({ code: resolved.code, message: resolved.error }) });
	const descriptor = resolved.ref.descriptor;
	const uri = descriptor.snapshot?.resourceUri;
	if (!uri) return Promise.resolve({ ok: false, error: normalizeAbmlError({ code: "HANDLE_NOT_FOUND", message: "ABML ref has no payload handle" }) });
	return readBrowserResultResource(uri).then((result) => result.ok
		? { ok: true, content: result.content }
		: { ok: false, error: normalizeAbmlError({ code: result.code, message: result.error }) });
}

export function networkEntryEntityFromRecord(record: Record<string, unknown>, context: CaptureRefContext) {
	return buildNetworkEntryEntity(record, context);
}

export function eventEntityFromRecord(record: Record<string, unknown>, context: CaptureRefContext) {
	return buildEventEntity(record, context);
}

export function replayInputFromNetworkRef(ref: RefDescriptor | string): { ok: true; requestHandle: string } | { ok: false; error: ReturnType<typeof normalizeAbmlError> } {
	const resolved = typeof ref === "string" ? resolveRefUriDetailed(ref) : { ok: true as const, ref: { descriptor: ref } as { descriptor: RefDescriptor } };
	if (!resolved.ok) return { ok: false, error: normalizeAbmlError({ code: resolved.code, message: resolved.error }) };
	const descriptor = resolved.ref.descriptor;
	const payload = descriptor.snapshot?.resourceUri;
	if (!payload) return { ok: false, error: normalizeAbmlError({ code: "HANDLE_NOT_FOUND", message: "network-entry ref has no replayable payload handle" }) };
	return { ok: true, requestHandle: payload };
}

export function eventOrSignalEntitiesFromEvidenceBundle(bundle: Record<string, unknown>, context: CaptureRefContext) {
	const sources = recordValue(bundle.sources) || {};
	const entities: Array<{ entity: ReturnType<typeof buildEventEntity>["entity"]; descriptor: ReturnType<typeof buildEventEntity>["descriptor"] }> = [];
	for (const [sourceName, raw] of Object.entries(sources)) {
		const source = recordValue(raw) || {};
		const payload = recordValue(source.data) || {};
		const events = Array.isArray(payload.events) ? payload.events : [];
		for (let index = 0; index < events.length; index += 1) {
			const event = recordValue(events[index]);
			if (!event) continue;
			entities.push(buildEventEntity({
				...event,
				event: stringValue(event.type) || stringValue(event.event) || sourceName,
				phase: sourceName,
			}, context));
		}
	}
	return entities;
}
