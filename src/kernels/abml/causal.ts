// ABML R3.x causal plane — P0 (passive network-delta) + P1 (initiator-enhanced attribution).
//
// Given the network records captured since a baseline observation, produce a budget-immune
// "what fired since baseline" summary for the observe envelope. P0 reports requests observed in
// the window; P1 attributes them to a control when an action context is present. CDP initiator
// metadata (type/url, NOT full call-stack parsing) filters structural noise and elevates
// confidence when the initiator confirms a script-triggered request. URLs are redacted + truncated;
// no bodies. Pure core: zero browser/Node deps.
import type { Entity, EntityRelation } from "./entity.js";
import { isRecord } from "../../utils/records.js";
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

// A non-network causal entry (R3.x P2) — a hook event (console / DOM-sink / storage / error / …)
// fired since the baseline. `selector` is present only when the event names its own target element
// (DOM-sink), which P2 part B uses for element-sourced attribution.
export type CausalEvent = {
	ref: string; // bp-ref://event/<seq|id>
	type: string; // console | domSink | storage | error | ...
	at?: number;
	summary?: string; // redacted + truncated; never a raw payload
	selector?: string; // the event's target element, when it names one
};

// Budget-immune envelope block. `unavailable` is emitted when no network recorder is active for
// the tab (P0 does NOT auto-start it — the agent opts in via `browser_network start`). R3.x P2 adds
// an optional `events` delta (hook events since baseline) alongside the network `requests`.
export type CausalSummary =
	| { sinceSeq: number; requests: CausalRequest[]; requestCount?: number; events?: CausalEvent[]; eventCount?: number }
	| { unavailable: string };

export const MAX_CAUSAL_REQUESTS = 12;
export const MAX_CAUSAL_EVENTS = 12;

// The TRUE number of requests fired since the baseline. `requests` is capped at MAX_CAUSAL_REQUESTS,
// so `requests.length` UNDERCOUNTS the delta whenever it was truncated — `requestCount` carries the
// real total in that case. Any "N requests fired" surfacing (e.g. the scan nextActions hint) must use
// this, not `requests.length`, or it under-reports 30×+ on a real SPA navigation (blind-eval R-G5 F2).
export function causalRequestsFiredCount(causal: CausalSummary): number {
	if (!("requests" in causal)) return 0;
	return typeof causal.requestCount === "number" ? causal.requestCount : causal.requests.length;
}

export function causalUserTriggeredCount(causal: CausalSummary): number {
	if (!("requests" in causal)) return 0;
	return causal.requests.filter((r) => !r.passive).length;
}

// The agent-facing "what fired since baseline" hint line. Reports the TRUE fired count and, when the
// inline `requests` preview is capped below that total, says where the rest live (browser_network list)
// — so the agent isn't left wondering whether the unseen requests are pageable (they are not; the
// causal block is a bounded preview, the recorder holds the full set).
export function causalFiredHint(causal: CausalSummary): string | undefined {
	if (!("requests" in causal) || !causal.requests.length) return undefined;
	const fired = causalRequestsFiredCount(causal);
	const shown = causal.requests.length;
	const more = fired > shown ? ` (first ${shown} shown inline; full set via browser_network list)` : "";
	return `${fired} request(s) fired since baseline → read envelope.causal.requests${more} (action→request attribution)`;
}
const MAX_URL_CHARS = 200;
const MAX_EVENT_SUMMARY_CHARS = 200;

// Redact sensitive substrings then clamp to a max length (shared by URL + event-summary shaping).
function redactClamp(text: string, max: number): string {
	const red = redactSensitiveText(text);
	return red.length > max ? `${red.slice(0, max)}…` : red;
}

function str(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function refIdComponent(value: string, fallback: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._~:@/-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || fallback;
}

function num(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function redactUrl(url: string): string {
	return redactClamp(url, MAX_URL_CHARS);
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
	const at = num(record.updatedAt) ?? num(record.createdAt) ?? num(record.wallTime);
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
	const requests = delta.slice(0, MAX_CAUSAL_REQUESTS).map(({ record }) => buildCausalRequest(record));
	return {
		sinceSeq,
		requests,
		...(delta.length > requests.length ? { requestCount: delta.length } : {}),
	};
}

// ── R3.x P2 — event (non-network) causal entries ─────────────────────────────────────────────────

// A short, redacted summary for a hook event: prefer a named text field (message/summary/preview/…),
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
// elementRef `{ nodeName, className, selector }`). Used by P2 part B for element-sourced attribution.
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
		...(summary ? { summary: redactClamp(summary, MAX_EVENT_SUMMARY_CHARS) } : {}),
		...(selector ? { selector } : {}),
	};
}

// Build the event-delta (hook events captured since the baseline seq). Mirrors buildCausalSummary:
// defensive seq>sinceSeq window, sorted ascending, capped at MAX_CAUSAL_EVENTS with the true count.
export function buildCausalEvents(records: Array<Record<string, unknown>>, sinceSeq: number): { events: CausalEvent[]; eventCount?: number } {
	const delta = deltaRecordsSinceSeq(records, sinceSeq);
	const events = delta.slice(0, MAX_CAUSAL_EVENTS).map(({ record }, index) => buildCausalEvent(record, index));
	return {
		events,
		...(delta.length > events.length ? { eventCount: delta.length } : {}),
	};
}

export function causalUnavailable(reason: string): CausalSummary {
	return { unavailable: reason };
}

// ── R3.x P2-C — seq cursor advance (stream-plane drain) ──────────────────────────────────────────

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

// ── R3.x P1 — attribution to a control (timing window only) ──────────────────────────────────────

// Cap on `triggered` edges attached to one control — keeps a heavy delta from evicting the
// control's R1 relations under the per-entity cap. The full list always stays in causal.requests.
export const MAX_TRIGGERED_RELATIONS = 8;

// Build `triggered` (control → network request) relations from the causal delta. Passive requests
// (parser/preload initiated) are excluded — they are structural, not action-caused. When
// hasActionRef is true AND the request has initiatorType "script", confidence is elevated to
// "medium" (multi-signal: timing window + CDP initiator type confirmation).
export function buildTriggeredRelations(causal: CausalSummary, options?: { hasActionRef?: boolean }): EntityRelation[] {
	if (!("requests" in causal)) return [];
	return causal.requests
		.filter((r) => !r.passive)
		.slice(0, MAX_TRIGGERED_RELATIONS)
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
// states "I just activated ref R"); else the R3 diff's `focusedRef`. FOCUS ROBUSTNESS: a ref is only
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

// ── R3.x P2-B — event-sourced attribution (element-named, stronger than timing) ───────────────────

// When a causal event names its own target element (`selector`, from a DOM-sink event's elementRef)
// and that selector resolves to a control/element entity, the event hangs a `triggered` edge on that
// entity → the event ref, source:"event" / confidence:"medium". This is STRONGER than P1's timing
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
