import { stableJson } from "../utils/json.js";
import { redactSensitiveValue } from "../artifacts/artifactPrivacy.js";
import { pruneObservationArtifacts, saveTextArtifact } from "../artifacts/artifactFiles.js";
import type { PageObservationV3, PageObservationView } from "../kernels/abml/pageObservation.js";
import { publicToolValue, type BrowserTextCommandResult } from "../utils/toolResult.js";
import { OBSERVATION_RESOURCES_DETAIL_KEY, projectObservationOverflow, projectObservationResources } from "./observe/observationResources.js";

type ArtifactContext = { cwd?: string } | undefined;

export type PageObservationResultOptions = {
	observation: PageObservationV3;
	artifactPath?: string;
	fallbackName: string;
	ctx?: ArtifactContext;
	details?: Record<string, unknown>;
	intent?: string;
};

const MAX_OBSERVATION_RESULT_BYTES = 32 * 1024;

export async function pageObservationResult(options: PageObservationResultOptions): Promise<BrowserTextCommandResult> {
	const artifactText = stableJson(options.observation);
	const saved = await saveTextArtifact(options.ctx, options.artifactPath, options.fallbackName, artifactText);
	await pruneObservationArtifacts(saved.path);
	let projected = projectObservationResources(options.observation, saved.path, options.intent);
	let modelSafe = publicToolValue(redactSensitiveValue(projected.observation)) as PageObservationView;
	let rendered = JSON.stringify(modelSafe);
	if (Buffer.byteLength(rendered, "utf8") > MAX_OBSERVATION_RESULT_BYTES) {
		projected = projectObservationOverflow(options.observation, saved.path);
		modelSafe = publicToolValue(redactSensitiveValue(projected.observation)) as PageObservationView;
		rendered = JSON.stringify(modelSafe);
	}
	return {
		content: [{ type: "text", text: rendered }],
		details: { ...(options.details ?? {}), [OBSERVATION_RESOURCES_DETAIL_KEY]: projected.resources },
	};
}
