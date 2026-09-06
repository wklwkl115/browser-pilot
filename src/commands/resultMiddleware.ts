import { stableJson } from "../utils/json.js";
import { pruneObservationArtifacts, saveTextArtifact } from "../artifacts/artifactFiles.js";
import type { PageObservationV3, PageObservationView } from "../kernels/abml/pageObservation.js";
import { publicToolValue, type BrowserTextCommandResult } from "../utils/toolResult.js";
import type { NormalizedTaskViewSpec } from "../kernels/abml/taskView.js";
import { projectTaskObservation } from "./observe/taskViewProjection.js";
import {
	OBSERVATION_RESOURCES_DETAIL_KEY,
	projectObservationOverflow,
	projectObservationResources,
} from "./observe/observationResources.js";

type ArtifactContext = { cwd?: string } | undefined;

export type PageObservationResultOptions = {
	observation: PageObservationV3;
	view?: NormalizedTaskViewSpec;
	artifactPath?: string;
	fallbackName: string;
	ctx?: ArtifactContext;
	details?: Record<string, unknown>;
};

const MAX_OBSERVATION_RESULT_BYTES = 32 * 1024;

export async function pageObservationResult(options: PageObservationResultOptions): Promise<BrowserTextCommandResult> {
	const artifactText = stableJson(options.observation);
	const saved = await saveTextArtifact(options.ctx, options.artifactPath, options.fallbackName, artifactText);
	void pruneObservationArtifacts(saved.path);
	let projected = options.view
		? await projectTaskObservation(options.observation, saved.path, artifactText, options.view)
		: projectObservationResources(options.observation, saved.path);
	let view = publicToolValue(projected.observation) as PageObservationView;
	let rendered = JSON.stringify(view);
	if (Buffer.byteLength(rendered, "utf8") > MAX_OBSERVATION_RESULT_BYTES) {
		if (options.view) throw new Error("Task view exceeded its final result budget");
		projected = projectObservationOverflow(options.observation, saved.path);
		view = publicToolValue(projected.observation) as PageObservationView;
		rendered = JSON.stringify(view);
	}
	return {
		content: [{ type: "text", text: rendered }],
		details: { ...(options.details ?? {}), [OBSERVATION_RESOURCES_DETAIL_KEY]: projected.resources },
	};
}
