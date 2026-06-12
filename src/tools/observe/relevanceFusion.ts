import type { Entity } from "../../abml/entity.js";
import { buildInferenceSummary } from "../../abml/inference.js";
import type { PerceptionTraceSnapshot } from "../../abml/perceptionLedger.js";
import { computeRelevanceMap, type RelevanceInput, type RelevanceResult, type RelevanceTerm } from "../../distill-core/relevance.js";
import { extractScalarTerm, extractUrlTerms } from "../../distill-core/relevanceTaps.js";
import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { isRecord } from "../../utils/params.js";
import type { ObserveToolParams } from "./scanRunner.js";

export function relevanceEnabled(params: ObserveToolParams): boolean {
	return process.env.PI_BROWSER_RELEVANCE !== "0" && String(params.detailLevel || "summary") !== "full";
}

export function observeIntent(params: ObserveToolParams): string | undefined {
	if (typeof params.intent === "string" && params.intent.trim()) return params.intent.trim();
	const nested = isRecord(params.params) ? params.params : undefined;
	return typeof nested?.intent === "string" && nested.intent.trim() ? nested.intent.trim() : undefined;
}

function traceTerms(snapshot: PerceptionTraceSnapshot | undefined): RelevanceTerm[] {
	return (snapshot?.terms ?? []).map((term, age) => ({ term: term.term, kind: term.kind as RelevanceTerm["kind"], weight: term.weight, age, source: "A" }));
}

function urlTerms(url: string | undefined): RelevanceTerm[] {
	return extractUrlTerms(url).map((term) => ({ ...term, source: "D" }));
}

function intentTerms(intent: string | undefined): RelevanceTerm[] {
	return extractScalarTerm(intent, "intent", 1.35).map((term) => ({ ...term, source: "E" }));
}

function archetypeTerms(inference: ReturnType<typeof buildInferenceSummary> | undefined): RelevanceTerm[] {
	return (inference?.intents ?? []).flatMap((item) => extractScalarTerm(item.intent, "intent", item.confidence === "high" ? 1.25 : 0.9).map((term) => ({ ...term, source: "C" as const })));
}

function entityRelevanceInputs(entities: Entity[]): RelevanceInput[] {
	const labelConsumers = new Map<string, string[]>();
	for (const entity of entities) {
		for (const rel of entity.relations ?? []) {
			if (rel.type !== "labelledBy") continue;
			const list = labelConsumers.get(rel.targetRef) ?? [];
			list.push(entity.ref);
			labelConsumers.set(rel.targetRef, list);
		}
	}
	return entities.map((entity) => {
		const selector = typeof entity.hints?.selector === "string" ? entity.hints.selector : undefined;
		const containerRole = typeof entity.hints?.containerRole === "string" ? entity.hints.containerRole : undefined;
		const containerName = typeof entity.hints?.containerName === "string" ? entity.hints.containerName : undefined;
		const container = [containerRole, containerName].filter(Boolean).join(" ") || undefined;
		return {
			ref: entity.ref,
			fields: {
				name: entity.name,
				role: entity.role,
				container,
				landmark: entity.structure?.landmark,
				value: entity.value,
				selector,
			},
			neighbors: {
				containerKey: container,
				labelledBySources: labelConsumers.get(entity.ref),
			},
		};
	});
}

export type ObserveRelevance = {
	result: RelevanceResult;
	artifact: Record<string, unknown>;
};

export function buildObserveRelevance(server: BrowserBridgeServer, params: ObserveToolParams, browserSessionId: string | undefined, url: string | undefined, entities: Entity[], inference?: ReturnType<typeof buildInferenceSummary>, memoryTerms: RelevanceTerm[] = []): ObserveRelevance | undefined {
	if (!relevanceEnabled(params)) return undefined;
	const trace = typeof server.perceptionTraceSnapshot === "function" ? server.perceptionTraceSnapshot(browserSessionId) : undefined;
	const terms = [
		...traceTerms(trace),
		...urlTerms(url),
		...archetypeTerms(inference),
		...intentTerms(observeIntent(params)),
		...memoryTerms,
	];
	if (!terms.length) return undefined;
	const result = computeRelevanceMap(entityRelevanceInputs(entities), terms);
	if (result.boosted <= 0) return undefined;
	const boostedRefs = Array.from(result.byRef.entries()).filter(([, match]) => match.score > 0).sort((a, b) => b[1].score - a[1].score).slice(0, 20).map(([ref, match]) => ({ ref, score: match.score, sources: match.sources }));
	return {
		result,
		artifact: {
			boosted: result.boosted,
			signals: result.signals,
			boostedRefs,
			...(process.env.PI_BROWSER_RELEVANCE_DEBUG === "1" ? { debugTerms: terms.map((term) => ({ kind: term.kind, source: term.source, age: term.age })).slice(0, 32) } : {}),
		},
	};
}
