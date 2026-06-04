// ABML R3.x causal plane — P0 (passive network-delta).
//
// Given the network records captured since a baseline observation, produce a budget-immune
// "what fired since baseline" summary for the observe envelope. This is the PASSIVE phase: it
// reports requests observed in the window with NO attribution to a specific control (that is P1,
// which needs an action context). Timing/seq-window only — it never parses CDP initiator stacks
// (a JS call stack, not a DOM element; mapping it would be brittle + per-site) and applies no
// per-site heuristics. URLs are redacted + truncated; no bodies. Pure core: zero browser/Node deps.
import type { Entity, EntityRelation } from "./entity.js";
import { isRecord } from "../utils/records.js";
import { redactSensitiveText } from "../utils/redaction.js";

export type CausalRequest = {
	// Stable id for the network entry; P1 will hang control→request relations on this ref.
	ref: string;
	method?: string;
	url?: string; // redacted (sensitive query values scrubbed) + truncated
	status?: number;
	type?: string; // resourceType (XHR / Fetch / Document / WebSocket / ...)
	at?: number; // last-update timestamp of the entry
};

// Budget-immune envelope block. `unavailable` is emitted when no network recorder is active for
// the tab (P0 does NOT auto-start it — the agent opts in via `browser_network start`).
export type CausalSummary =
	| { sinceSeq: number; requests: CausalRequest[]; requestCount?: number }
	| { unavailable: string };

export const MAX_CAUSAL_REQUESTS = 12;
const MAX_URL_CHARS = 200;

function str(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function num(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function redactUrl(url: string): string {
	const red = redactSensitiveText(url);
	return red.length > MAX_URL_CHARS ? `${red.slice(0, MAX_URL_CHARS)}…` : red;
}

// One network record → a compact, redacted causal request. Tolerant of both the full NetworkRecord
// shape and the network.list summary shape (fields read defensively, like stream.ts).
export function buildCausalRequest(record: Record<string, unknown>): CausalRequest {
	const request = isRecord(record.request) ? record.request : {};
	const response = isRecord(record.response) ? record.response : {};
	const requestId = str(record.requestId) || str(record.id) || str(record._requestId) || "request";
	const url = str(request.url) || str(record.url) || str(response.url);
	const method = str(request.method) || str(record.method);
	const status = num(response.status) ?? num(record.status);
	const type = str(record.type) || str(record.resourceType);
	const at = num(record.updatedAt) ?? num(record.createdAt) ?? num(record.wallTime);
	return {
		ref: `pi-ref://network/${requestId}`,
		...(method ? { method } : {}),
		...(url ? { url: redactUrl(url) } : {}),
		...(status !== undefined ? { status } : {}),
		...(type ? { type } : {}),
		...(at !== undefined ? { at } : {}),
	};
}

// Build the causal summary from the delta records (captured since the baseline seq). Records are
// expected to already be the seq>sinceSeq window (the query layer filters via network.list
// sinceSeq); a defensive seq filter is applied here so the pure function is self-contained.
export function buildCausalSummary(records: Array<Record<string, unknown>>, sinceSeq: number): CausalSummary {
	const delta = records
		.filter((r) => {
			const seq = num(r.seq);
			return seq === undefined || seq > sinceSeq;
		})
		.sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0));
	const requests = delta.slice(0, MAX_CAUSAL_REQUESTS).map((r) => buildCausalRequest(r));
	return {
		sinceSeq,
		requests,
		...(delta.length > requests.length ? { requestCount: delta.length } : {}),
	};
}

export function causalUnavailable(reason: string): CausalSummary {
	return { unavailable: reason };
}

// ── R3.x P1 — attribution to a control (timing window only) ──────────────────────────────────────

// Cap on `triggered` edges attached to one control — keeps a heavy delta from evicting the
// control's R1 relations under the per-entity cap. The full list always stays in causal.requests.
export const MAX_TRIGGERED_RELATIONS = 8;

// Build `triggered` (control → network request) relations from the causal delta. Each points at a
// `pi-ref://network/<id>` resolvable inline in envelope.causal.requests. source "timing", confidence
// "low": this is timing-window attribution ("fired after the activated control"), NOT an initiator-
// stack proof — the honest confidence ceiling for a passive observer. Empty when no requests/unavailable.
export function buildTriggeredRelations(causal: CausalSummary): EntityRelation[] {
	if (!("requests" in causal)) return [];
	return causal.requests.slice(0, MAX_TRIGGERED_RELATIONS).map((request) => ({
		type: "triggered" as const,
		targetRef: request.ref,
		source: "timing" as const,
		confidence: "low" as const,
		evidence: {
			since: causal.sinceSeq,
			...(request.method ? { method: request.method } : {}),
			...(request.status !== undefined ? { status: request.status } : {}),
		},
	}));
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
