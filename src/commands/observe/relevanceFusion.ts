import type { Entity } from "../../kernels/abml/entity.js";
import { buildInferenceSummary } from "../../kernels/abml/inference.js";
import { extractScalarTerm, extractUrlTerms } from "../../kernels/evidence/distill/relevanceTaps.js";
import type { BrowserCommandRuntimePort, CommandPerceptionTraceSnapshot } from "../../ports/BrowserCommandRuntimePort.js";
import type { ObserveToolParams } from "./common.js";
import { computeObserveRelevanceMap } from "./relevanceScoring.js";
import type { ObserveRelevanceInput, ObserveRelevanceResult, ObserveRelevanceTerm } from "./relevanceTypes.js";

export function relevanceEnabled(params: ObserveToolParams): boolean {
	return process.env.BROWSER_PILOT_RELEVANCE !== "0" && String(params.detailLevel || "summary") !== "full";
}

export function observeIntent(params: ObserveToolParams): string | undefined {
	return typeof params.intent === "string" && params.intent.trim() ? params.intent.trim() : undefined;
}

function traceTerms(snapshot: CommandPerceptionTraceSnapshot | undefined): ObserveRelevanceTerm[] {
	return (snapshot?.terms ?? []).map((term, age) => ({ term: term.term, kind: term.kind as ObserveRelevanceTerm["kind"], weight: term.weight, age, source: "A" }));
}

function urlTerms(url: string | undefined): ObserveRelevanceTerm[] {
	return extractUrlTerms(url).map((term) => ({ ...term, source: "D" }));
}

function intentTerms(intent: string | undefined): ObserveRelevanceTerm[] {
	return extractScalarTerm(intent, "intent", 1.35).map((term) => ({ ...term, source: "E" }));
}

function archetypeTerms(inference: ReturnType<typeof buildInferenceSummary> | undefined): ObserveRelevanceTerm[] {
	return (inference?.intents ?? []).flatMap((item) => extractScalarTerm(item.intent, "intent", item.confidence === "high" ? 1.25 : 0.9).map((term) => ({ ...term, source: "C" as const })));
}

function entityRelevanceInputs(entities: Entity[]): ObserveRelevanceInput[] {
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
	result: ObserveRelevanceResult;
	artifact: Record<string, unknown>;
};

export function buildObserveRelevance(server: BrowserCommandRuntimePort, params: ObserveToolParams, browserSessionId: string | undefined, url: string | undefined, entities: Entity[], inference?: ReturnType<typeof buildInferenceSummary>): ObserveRelevance | undefined {
	if (!relevanceEnabled(params)) return undefined;
	const trace = typeof server.perceptionTraceSnapshot === "function" ? server.perceptionTraceSnapshot(browserSessionId) : undefined;
	const terms = [
		...traceTerms(trace),
		...urlTerms(url),
		...archetypeTerms(inference),
		...intentTerms(observeIntent(params)),
	];
	if (!terms.length) return undefined;
	const result = computeObserveRelevanceMap(entityRelevanceInputs(entities), terms);
	if (result.boosted <= 0) return undefined;
	const boostedRefs = Array.from(result.byRef.entries()).filter(([, match]) => match.score > 0).sort((a, b) => b[1].score - a[1].score).slice(0, 20).map(([ref, match]) => ({ ref, score: match.score, sources: match.sources }));
	return {
		result,
		artifact: {
			boosted: result.boosted,
			signals: result.signals,
			boostedRefs,
			...(process.env.BROWSER_PILOT_RELEVANCE_DEBUG === "1" ? { debugTerms: terms.map((term) => ({ kind: term.kind, source: term.source, age: term.age })).slice(0, 32) } : {}),
		},
	};
}
