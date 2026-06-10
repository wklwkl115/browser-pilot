export type ArtifactPlanReason =
	| "explicit-output"
	| "sensitive-raw"
	| "over-threshold"
	| "summary-over-threshold"
	| "fallback-over-budget"
	| "full-sensitive-or-over-budget";

export type ArtifactPlan = {
	kind: "saveText";
	text: string;
	fallbackName: string;
	outputPath?: string;
	reasons: ArtifactPlanReason[];
};

export function artifactPlanReasons(input: { outputPath?: string; sensitiveRaw: boolean; rawLength: number; threshold: number; summaryThreshold: number; summaryLike: boolean }): ArtifactPlanReason[] {
	const reasons: ArtifactPlanReason[] = [];
	if (input.outputPath) reasons.push("explicit-output");
	if (input.sensitiveRaw) reasons.push("sensitive-raw");
	if (input.rawLength > input.threshold) reasons.push("over-threshold");
	if (input.summaryLike && input.rawLength > input.summaryThreshold) reasons.push("summary-over-threshold");
	return reasons;
}

export function buildSaveTextArtifactPlan(input: { text: string; fallbackName: string; outputPath?: string; reasons: ArtifactPlanReason[] }): ArtifactPlan | undefined {
	return input.reasons.length ? { kind: "saveText", text: input.text, fallbackName: input.fallbackName, outputPath: input.outputPath, reasons: input.reasons } : undefined;
}
