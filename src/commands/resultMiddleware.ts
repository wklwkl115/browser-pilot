import { stableJson } from "../utils/json.js";
import { containsSensitiveEvidence, redactSensitiveValue } from "../artifacts/artifactPrivacy.js";
import { saveTextArtifact } from "../artifacts/artifactFiles.js";
import { redactForModel } from "./resultRedaction.js";
import type { PageObservationV3 } from "../kernels/abml/pageObservation.js";
import type { BrowserTextCommandResult } from "../utils/toolResult.js";
import { OBSERVATION_RESOURCES_DETAIL_KEY, projectObservationResources } from "./observe/observationResources.js";
import { createCodedError } from "../utils/codedError.js";

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
	observation: PageObservationV3;
	artifactPath?: string;
	fallbackName: string;
	ctx?: ArtifactContext;
	details?: Record<string, unknown>;
};

const MAX_OBSERVATION_RESULT_BYTES = 24 * 1024 * 1024;

export async function pageObservationResult(options: PageObservationResultOptions): Promise<BrowserTextCommandResult> {
	const artifactText = stableJson(options.observation);
	const saved = await saveTextArtifact(options.ctx, options.artifactPath, options.fallbackName, artifactText);
	const projected = projectObservationResources(options.observation, saved.path);
	const modelSafe = redactSensitiveValue(projected.observation) as PageObservationV3;
	const rendered = stableJson(modelSafe);
	const bytes = Buffer.byteLength(rendered, "utf8");
	if (bytes > MAX_OBSERVATION_RESULT_BYTES) {
		throw createCodedError({ name: "ObservationResultError", code: "OBSERVATION_TOO_LARGE", message: "PageObservation exceeds the MCP transport safety limit", details: { bytes, maxBytes: MAX_OBSERVATION_RESULT_BYTES } });
	}
	return {
		content: [{ type: "text", text: rendered }],
		details: { ...(options.details ?? {}), [OBSERVATION_RESOURCES_DETAIL_KEY]: projected.resources },
	};
}
