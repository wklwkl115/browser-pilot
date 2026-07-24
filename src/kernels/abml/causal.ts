// ABML causal plane with passive network deltas and initiator-enhanced attribution.
//
// Given the network records captured since a baseline observation, produce a complete
// "what fired since baseline" summary for the observe envelope. It reports requests observed in
// the window and attributes them to a control when an action context is present. CDP initiator
// metadata (type/url, NOT full call-stack parsing) filters structural noise and elevates
// confidence when the initiator confirms a script-triggered request. URLs are redacted;
// no bodies. Pure core: zero browser/Node deps.
import type { Entity, EntityRelation } from "./entity.js";
import { finiteNumber as num, isRecord, nonEmptyString as str } from "../../utils/records.js";
import { redactSensitiveText } from "../../utils/redaction.js";
import { mintRef } from "../refs/core.js";

export type CausalRequest = {
	ref: string;
	method?: string;
	url?: string;
	status?: number;
	type?: string;
	at?: number;
	initiatorType?: string; // CDP initiator.type — "script"|"parser"|"preload"|"other"
	passive?: boolean; // true for structural requests (parser/preload) — excluded from triggered attribution
};

// A non-network causal entry: a hook event (console / DOM-sink / storage / error / ...)
// fired since the baseline. `selector` is present only when the event names its own target element
// (DOM-sink), enabling element-sourced attribution.
export type CausalEvent = {
	ref: string; // bp-ref://event/<seq|id>
	type: string; // console | domSink | storage | error | ...
	at?: number;
	summary?: string; // redacted; never a raw payload
	selector?: string; // the event's target element, when it names one
};

// `unavailable` is emitted when no network recorder is active for
// the tab; the agent opts in via `browser_command network.start`. The optional `events` field carries
// hook events since baseline alongside the network `requests`.
export type CausalSummary =
	| { sinceSeq: number; requests: CausalRequest[]; requestCount?: number; events?: CausalEvent[]; eventCount?: number }
	| { unavailable: string; events?: CausalEvent[]; eventCount?: number };

export function causalRequestsFiredCount(causal: CausalSummary): number {
	if (!("requests" in causal)) return 0;
	return typeof causal.requestCount === "number" ? causal.requestCount : causal.requests.length;
}

export function causalFiredHint(causal: CausalSummary): string | undefined {
	if (!("requests" in causal) || !causal.requests.length) return undefined;
	const fired = causalRequestsFiredCount(causal);
	return `${fired} request(s) fired since baseline → read causal.requests and its frontier resource when folded (action→request attribution)`;
}

function refIdComponent(value: string, fallback: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._~:@/-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || fallback;
}

function redactUrl(url: string): string {
	return redactSensitiveText(url);
}

function deltaRecordsSinceSeq(records: Array<Record<string, unknown>>, sinceSeq: number): Array<{ record: Record<string, unknown>; seq: number }> {
	return records
		.map((record) => {
			const seq = num(record.seq);
			return { record, seq: seq ?? 0, include: seq === undefined || seq > sinceSeq };
		})
		.filter((item) => item.include)
		.sort((a, b) => a.seq - b.seq)
		.map(({ record, seq }) => ({ record, seq }));
}

// One network record → a compact, redacted causal request. Tolerant of both the full NetworkRecord
// shape and the network.list summary shape (fields read defensively, like stream.ts).
const PASSIVE_INITIATOR_TYPES = new Set(["parser", "preload", "preflight"]);

export function buildCausalRequest(record: Record<string, unknown>): CausalRequest {
	const request = isRecord(record.request) ? record.request : {};
	const response = isRecord(record.response) ? record.response : {};
	const requestId = str(record.requestId) || str(record.id) || str(record._requestId) || "request";
	const url = str(request.url) || str(record.url) || str(response.url);
	const method = str(request.method) || str(record.method);
	const status = num(response.status) ?? num(record.status);
	const type = str(record.type) || str(record.resourceType);
	const at = num(record.createdAt) ?? num(record.updatedAt) ?? num(record.wallTime);
	const initiator = isRecord(record.initiator) ? record.initiator : {};
	const initiatorType = str(initiator.type) || str(record.initiatorType);
	const passive = initiatorType ? PASSIVE_INITIATOR_TYPES.has(initiatorType) : undefined;
	return {
		ref: mintRef("network", refIdComponent(requestId, "request")),
		...(method ? { method } : {}),
		...(url ? { url: redactUrl(url) } : {}),
		...(status !== undefined ? { status } : {}),
		...(type ? { type } : {}),
		...(at !== undefined ? { at } : {}),
		...(initiatorType ? { initiatorType } : {}),
		...(passive ? { passive } : {}),
	};
}

// Build the causal summary from the delta records (captured since the baseline seq). Records are
// expected to already be the seq>sinceSeq window (the query layer filters via network.list
// sinceSeq); a defensive seq filter is applied here so the pure function is self-contained.
export function buildCausalSummary(records: Array<Record<string, unknown>>, sinceSeq: number): CausalSummary {
	const delta = deltaRecordsSinceSeq(records, sinceSeq);
	const requests = delta.map(({ record }) => buildCausalRequest(record));
	return {
		sinceSeq,
		requests,
	};
}

// Event (non-network) causal entries.

// A redacted summary for a hook event: prefer a named text field (message/summary/preview/…),
// never dump the raw payload object. Falls back to undefined so the entry stays compact.
function eventSummary(data: unknown): string | undefined {
	if (typeof data === "string") return data;
	if (!isRecord(data)) return undefined;
	const direct = str(data.message) || str(data.summary) || str(data.preview) || str(data.text) || str(data.value) || str(data.url);
	if (direct) return direct;
	// console.* events carry their message in `args` (the hook records `{ args, stack }`); the first
	// string arg is the human-meaningful summary. Generic shape, no per-event-type branching.
	if (Array.isArray(data.args)) {
		const first = data.args.find((a) => typeof a === "string" && a.trim());
		if (typeof first === "string") return first;
	}
	return undefined;
}

// The event's target element selector, when the hook recorded one (DOM-sink events carry an
// elementRef `{ nodeName, className, selector }`). Used for element-sourced attribution.
function eventSelector(record: Record<string, unknown>): string | undefined {
	const data = isRecord(record.data) ? record.data : {};
	const el = isRecord(record.elementRef) ? record.elementRef : isRecord(data.elementRef) ? data.elementRef : isRecord(data.element) ? data.element : undefined;
	return str(record.selector) || str(data.selector) || (el ? str(el.selector) : undefined);
}

// One hook event → a compact, redacted causal event. Tolerant of the HookEvent shape
// (`{ seq, type, timestamp, data }`) and defensive field aliases, like buildCausalRequest.
export function buildCausalEvent(record: Record<string, unknown>, fallbackIndex?: number): CausalEvent {
	const seq = num(record.seq);
	const id = str(record.id) || (seq !== undefined ? String(seq) : fallbackIndex !== undefined ? `event-${fallbackIndex}` : "event");
	const type = str(record.type) || str(record.event) || str(record.eventType) || "event";
	const at = num(record.timestamp) ?? num(record.t) ?? num(record.at);
	const summary = eventSummary(record.data ?? record.summary ?? record.message);
	const selector = eventSelector(record);
	return {
		ref: mintRef("event", refIdComponent(id, "event")),
		type,
		...(at !== undefined ? { at } : {}),
		...(summary ? { summary: redactSensitiveText(summary) } : {}),
		...(selector ? { selector } : {}),
	};
}

// Build the event-delta (hook events captured since the baseline seq). Mirrors buildCausalSummary.
export function buildCausalEvents(records: Array<Record<string, unknown>>, sinceSeq: number): { events: CausalEvent[]; eventCount?: number } {
	const delta = deltaRecordsSinceSeq(records, sinceSeq);
	const events = delta.map(({ record }, index) => buildCausalEvent(record, index));
	return {
		events,
	};
}

export function causalUnavailable(reason: string): CausalSummary {
	return { unavailable: reason };
}

// Sequence cursor advance for stream-plane drains.

// The highest `seq` over a delta window — the new cursor after a drain. Pure + self-contained so the
// stream-plane "advance to the last consumed entry" contract is unit-testable. Returns undefined when
// no record carries a numeric seq (the caller keeps its prior cursor in that case).
export function latestSeq(records: Array<Record<string, unknown>>): number | undefined {
	let max: number | undefined;
	for (const record of records) {
		const seq = num(record.seq);
		if (seq !== undefined && (max === undefined || seq > max)) max = seq;
	}
	return max;
}

// Attribution to a control using the timing window.

// Build `triggered` (control → network request) relations from the causal delta. Passive requests
// (parser/preload initiated) are excluded — they are structural, not action-caused. When
// hasActionRef is true AND the request has initiatorType "script", confidence is elevated to
// "medium" (multi-signal: timing window + CDP initiator type confirmation).
export function buildTriggeredRelations(causal: CausalSummary, options?: { hasActionRef?: boolean; actionAt?: number }): EntityRelation[] {
	if (!("requests" in causal)) return [];
	return causal.requests
		.filter((r) => !r.passive && (options?.actionAt === undefined || r.at !== undefined && r.at >= options.actionAt))
		.map((request) => {
			const initiatorConfirmed = request.initiatorType === "script" && options?.hasActionRef;
			return {
				type: "triggered" as const,
				targetRef: request.ref,
				source: "timing" as const,
				confidence: (initiatorConfirmed ? "medium" : "low") as "medium" | "low",
				evidence: {
					since: causal.sinceSeq,
					...(request.method ? { method: request.method } : {}),
					...(request.status !== undefined ? { status: request.status } : {}),
					...(initiatorConfirmed ? { initiatorType: "script" as const } : {}),
				},
			};
		});
}

// Decide which control the causal delta is attributed to. Prefers an explicit `actionRef` (the agent
// states "I just activated ref R"); else the temporal diff's `focusedRef`. A ref is only
// accepted when it resolves to a focusable control/element entity — a `focusedRef` that lands on a
// frame/region (observed on live pages) is rejected, so the delta is never mis-attributed. Returns
// undefined when no trustworthy control is identified (causal stays present, just without `triggered`).
export function resolveActionEntityRef(actionRef: string | undefined, focusedRef: string | undefined, entities: Entity[]): string | undefined {
	const resolveActionable = (ref: string | undefined): string | undefined => {
		if (!ref) return undefined;
		const entity = entities.find((candidate) => candidate.ref === ref);
		if (!entity) return undefined;
		return entity.kind === "control" || entity.kind === "element" ? entity.ref : undefined;
	};
	return resolveActionable(actionRef) ?? resolveActionable(focusedRef);
}

// Event-sourced attribution when the event names an element.

// When a causal event names its own target element (`selector`, from a DOM-sink event's elementRef)
// and that selector resolves to a control/element entity, the event hangs a `triggered` edge on that
// entity → the event ref, source:"event" / confidence:"medium". This is stronger than timing
// attribution: the event records the element it fired on — no timing guess. Returns entityRef →
// triggered edges; entities without a matching event get none (the event still ships in causal.events).
export function eventTriggeredByEntity(events: CausalEvent[], entities: Entity[]): Map<string, EntityRelation[]> {
	const out = new Map<string, EntityRelation[]>();
	if (!events.length) return out;
	const bySelector = new Map<string, string>();
	for (const entity of entities) {
		const selector = isRecord(entity.hints) && typeof entity.hints.selector === "string" ? entity.hints.selector.trim() : "";
		if (selector && (entity.kind === "control" || entity.kind === "element") && !bySelector.has(selector)) bySelector.set(selector, entity.ref);
	}
	if (!bySelector.size) return out;
	for (const event of events) {
		const selector = event.selector?.trim();
		if (!selector) continue;
		const entityRef = bySelector.get(selector);
		if (!entityRef) continue;
		const relation: EntityRelation = { type: "triggered", targetRef: event.ref, source: "event", confidence: "medium", evidence: { eventType: event.type } };
		const list = out.get(entityRef);
		if (list) list.push(relation);
		else out.set(entityRef, [relation]);
	}
	return out;
}
