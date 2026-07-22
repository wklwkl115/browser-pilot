import { stableJson } from "../utils/json.js";
import { containsSensitiveEvidence } from "../artifacts/artifactPrivacy.js";
import { saveTextArtifact } from "../artifacts/artifactFiles.js";
import { redactForModel } from "./resultRedaction.js";
import { renderWithExactCost } from "../kernels/evidence/cost.js";
import type { ObservationFrontierItem, PageObservationV3 } from "../kernels/abml/pageObservation.js";
import type { BrowserTextCommandResult } from "../utils/toolResult.js";

type ArtifactContext = { cwd?: string } | undefined;

function compactSaved(saved: Awaited<ReturnType<typeof saveTextArtifact>>) {
	return { path: saved.path, chars: saved.chars, bytes: saved.bytes, ...(saved.privacy ? { privacy: saved.privacy } : {}) };
}

export async function simpleJsonResult(value: unknown, options: {
	maxChars: number;
	ctx?: ArtifactContext;
	outputPath?: string;
	fallbackName: string;
	details?: Record<string, unknown>;
}): Promise<BrowserTextCommandResult> {
	const maxChars = Math.max(1, Math.floor(options.maxChars));
	const raw = stableJson(value);
	const needsArtifact = Boolean(options.outputPath) || containsSensitiveEvidence(value) || raw.length > maxChars;
	const saved = needsArtifact ? await saveTextArtifact(options.ctx, options.outputPath, options.fallbackName, raw) : undefined;
	const safeValue = redactForModel(value, saved, value);
	const rendered = stableJson(safeValue);
	const inline = rendered.length <= maxChars
		? rendered
		: stableJson({ saved: saved ? compactSaved(saved) : compactSaved(await saveTextArtifact(options.ctx, options.outputPath, options.fallbackName, raw)) });
	return {
		content: [{ type: "text", text: inline }],
		details: { ...(options.details ?? {}), ...(saved ? { saved: compactSaved(saved) } : {}) },
	};
}

export type PageObservationResultOptions = {
	inline: PageObservationV3;
	artifact: PageObservationV3;
	maxChars: number;
	outputPath?: string;
	fallbackName: string;
	ctx?: ArtifactContext;
	details?: Record<string, unknown>;
	onAllocation?: (allocation: { budgetUsedRatio: number; omittedCount: number }) => void;
};

function observationWithExactCost(observation: PageObservationV3): { value: PageObservationV3; rendered: string } {
	return renderWithExactCost(observation, (current, cost) => ({ ...current, limits: { ...current.limits, cost } }));
}

function overflowFrontierItem(field: string): ObservationFrontierItem {
	return {
		ref: `frontier:inline:${field}`,
		kind: field === "snapshotProjection" ? "template-instances" : field === "collections" ? "collection-window" : "diagnostics",
		state: "truncated",
		read: { tool: "browser_artifact", mode: "json", pathRef: "saved.path", jsonPath: field },
	};
}

function fitPageObservationInline(observation: PageObservationV3, maxChars: number) {
	let current = { ...observation, limits: { ...observation.limits, budgetChars: maxChars } };
	let exact = observationWithExactCost(current);
	let omittedCount = 0;
	for (const field of ["artifact_hints", "diagnostics", "treeDiff", "causal", "diff", "inference", "identity", "relations", "snapshotProjection", "collections", "entities", "outline", "nextActions", "gist"] as const) {
		if (exact.rendered.length <= maxChars || current[field] === undefined) continue;
		const { [field]: _omitted, ...rest } = current;
		const item = overflowFrontierItem(field);
		current = {
			...rest,
			frontier: { items: [...current.frontier.items.filter((existing) => existing.read?.jsonPath !== field), item] },
			limits: { ...current.limits, truncated: true },
		} as PageObservationV3;
		omittedCount += 1;
		exact = observationWithExactCost(current);
	}
	if (exact.rendered.length > maxChars) throw new Error(`PageObservation cannot fit maxChars=${maxChars}; minimum rendered size is ${exact.rendered.length}`);
	return { observation: exact.value, rendered: exact.rendered, omittedCount };
}

export async function pageObservationResult(options: PageObservationResultOptions): Promise<BrowserTextCommandResult> {
	const artifactText = observationWithExactCost(options.artifact).rendered;
	const saved = await saveTextArtifact(options.ctx, options.outputPath, options.fallbackName, artifactText);
	const savedDescriptor = compactSaved(saved);
	const modelSafe = redactForModel({ ...options.inline, saved: savedDescriptor }, saved, options.artifact) as PageObservationV3;
	const fitted = fitPageObservationInline(modelSafe, Math.max(1, Math.floor(options.maxChars)));
	options.onAllocation?.({ budgetUsedRatio: Math.min(1, fitted.rendered.length / Math.max(1, options.maxChars)), omittedCount: fitted.omittedCount });
	return {
		content: [{ type: "text", text: fitted.rendered }],
		details: { ...(options.details ?? {}), saved: savedDescriptor },
	};
}
