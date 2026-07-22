import { stableJson } from "../utils/json.js";
import { redactSensitiveValue } from "../artifacts/artifactPrivacy.js";
import { saveTextArtifact } from "../artifacts/artifactFiles.js";
import type { PageObservationV3 } from "../kernels/abml/pageObservation.js";
import type { BrowserTextCommandResult } from "../utils/toolResult.js";
import { OBSERVATION_RESOURCES_DETAIL_KEY, projectObservationResources } from "./observe/observationResources.js";
import { createCodedError } from "../utils/codedError.js";

type ArtifactContext = { cwd?: string } | undefined;

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
