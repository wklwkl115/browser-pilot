import { allocateFacts } from "../kernels/evidence/distill/allocate.js";
import { renderFacts, type RenderedFacts } from "../kernels/evidence/distill/render.js";
import { fitSalienceEnvelopeBudget } from "../kernels/evidence/distill/salienceEnvelope.js";
import { fitCommandEnvelopeBudget } from "./resultBudgeting.js";
import { getDistillerDefinition } from "./distillerRegistry.js";
import type { CommandFactGranularity, DistilledEnvelope } from "./resultTypes.js";

export type FactRenderingDiagnostics = {
	rendered: number;
	skipped: number;
	markerCount: number;
	planes: string[];
};

type BudgetOptions = {
	commandName: string;
	command?: string;
	granularityCeiling?: Exclude<CommandFactGranularity, "omit">;
	stableRefs?: Set<string>;
};

export function rendererMarker(): DistilledEnvelope["renderer"] | undefined {
	return process.env.BROWSER_PILOT_RENDERER === "ladder" ? undefined : "salience-v1";
}

function allocationCostModel(): "byte" | "token" {
	return process.env.BROWSER_PILOT_TOKEN_COST === "1" ? "token" : "byte";
}

export function factRenderingDiagnostics(options: BudgetOptions, value: unknown, maxChars: number): FactRenderingDiagnostics | undefined {
	if (!rendererMarker()) return undefined;
	const factify = getDistillerDefinition(options.commandName)?.factify;
	if (!factify) return undefined;
	const facts = factify(value, options.command);
	if (!facts.length) return undefined;
	const budget = Math.max(256, Math.floor(maxChars * 0.25));
	const plan = allocateFacts(facts, budget, [{ plane: "summary", minFacts: 1, minGranularity: "compact" }], { minDensity: 0.01, costModel: allocationCostModel(), stableRefs: options.stableRefs });
	const rendered: RenderedFacts = renderFacts(facts, plan);
	const planes = Object.keys(rendered).filter((key) => key !== "omitted" && key !== "stats").sort();
	return {
		rendered: rendered.stats?.factsRendered ?? 0,
		skipped: rendered.stats?.factsOmitted ?? 0,
		markerCount: rendered.stats?.truncationMarkers ?? 0,
		planes,
	};
}

export function fitResponseEnvelope(envelope: DistilledEnvelope, maxChars: number, options: BudgetOptions): DistilledEnvelope {
	return rendererMarker() ? fitSalienceEnvelopeBudget(envelope, maxChars, { granularityCeiling: options.granularityCeiling }) : fitCommandEnvelopeBudget(envelope, maxChars);
}

export function renderedOmittedCount(envelope: DistilledEnvelope): number {
	const omitted = envelope.summary.rendererOmitted;
	return Array.isArray(omitted) ? omitted.filter((item) => typeof item === "string").length : 0;
}
