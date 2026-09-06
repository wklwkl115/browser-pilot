import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { artifactFallbackName, saveTextArtifact } from "../../src/artifacts/artifactFiles.ts";
import { packTaskView, taskArtifactHash } from "../../src/commands/observe/taskViewProjection.ts";
import {
	projectObservationResources,
	projectObservationOverflow,
	OBSERVATION_RESOURCES_DETAIL_KEY,
	OBSERVATION_RESOURCE_URI_PREFIX,
} from "../../src/commands/observe/observationResources.ts";
import { renderMcpToolResult, registerMcpObservationResources, readMcpResource } from "../../src/apps/mcp/server.ts";
import { publicToolValue } from "../../src/utils/toolResult.ts";
import { bindTaskNeed, TASK_NEED_ORACLE } from "./task-need-oracle.mjs";
import { evaluateNeedPath, NEED_READING_BUDGET, responseBytes } from "./task-need-reading.mjs";

async function savedObservation(result, projectRoot) {
	const descriptors = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] ?? [];
	const task = descriptors.find((item) => item.taskProjection);
	const canonical = descriptors.find((item) => item.jsonPath === "$");
	if (!task || !canonical)
		throw new Error("Equivalent-need comparison requires a saved task and canonical observation");
	registerMcpObservationResources(result.details, projectRoot);
	// Validate project scope, expiry and artifact integrity using the production resource reader.
	await readMcpResource(task.uri, projectRoot);
	await readMcpResource(canonical.uri, projectRoot);
	const artifact = JSON.parse(await readFile(task.path, "utf8"));
	const canonicalText = await readFile(canonical.path, "utf8");
	const observation = JSON.parse(canonicalText);
	if (
		taskArtifactHash(canonicalText) !== artifact.canonicalSha256 ||
		observation.snapshot.snapshotId !== artifact.snapshotId
	)
		throw new Error("Equivalent-need canonical digest or snapshot mismatch");
	return { descriptors, task, canonical, artifact, canonicalText, observation };
}

async function readingConfigurations(result, projectRoot, saved) {
	const { task, canonical, artifact, observation, canonicalText, descriptors } = saved;
	const fallback = descriptors.find((item) => item.taskEvidence) ?? {
		...canonical,
		uri: `${OBSERVATION_RESOURCE_URI_PREFIX}${randomUUID()}`,
		jsonPath: undefined,
		ref: "frontier:task-evidence",
		name: "Captured snapshot evidence",
		taskEvidence: { sha256: taskArtifactHash(canonicalText), policy: artifact.policy },
	};
	const fallbackItem = {
		ref: "frontier:task-evidence",
		kind: "details",
		state: "folded",
		label: "Captured snapshot evidence",
		resourceUri: fallback.uri,
	};
	const withFallback = (view) => ({
		...view,
		frontier: {
			items: [...(view.frontier?.items ?? []).filter((item) => item.resourceUri !== fallback.uri), fallbackItem],
		},
	});
	let page = projectObservationResources(observation, canonical.path);
	if (responseBytes(publicToolValue(withFallback(page.observation))) > 32768)
		page = projectObservationOverflow(observation, canonical.path);
	const wholeArtifact = { ...artifact, packets: [] };
	const wholeText = JSON.stringify(wholeArtifact);
	const filename = artifactFallbackName("observe-equivalent-groups");
	const wholeSaved = await saveTextArtifact(
		{ cwd: projectRoot },
		path.join(path.dirname(task.path), filename),
		filename,
		wholeText,
	);
	const wholeDescriptor = {
		...task,
		uri: `${OBSERVATION_RESOURCE_URI_PREFIX}${randomUUID()}`,
		path: wholeSaved.path,
		taskProjection: { sha256: taskArtifactHash(wholeText) },
	};
	const canonicalFrontier = {
		items: [
			{
				ref: "frontier:observation",
				kind: "details",
				state: "folded",
				label: "Complete semantic observation",
				resourceUri: canonical.uri,
			},
		],
	};
	const inlineBudget = 32768 - responseBytes(fallbackItem) - 64;
	const profiles = {
		page: { view: page.observation, descriptors: page.resources },
		wholeGroup: {
			view: packTaskView(observation, wholeArtifact, wholeDescriptor.uri, canonicalFrontier, inlineBudget),
			descriptors: [wholeDescriptor, canonical],
		},
		progressivePacket: {
			view: packTaskView(observation, artifact, task.uri, canonicalFrontier, inlineBudget),
			descriptors: [task, canonical],
		},
	};
	return Object.fromEntries(
		Object.entries(profiles).map(([profile, configuration]) => {
			const allowed = [...configuration.descriptors, fallback];
			const initialResponse = renderMcpToolResult(
				"browser_observe",
				{
					...result,
					content: [
						{ type: "text", text: JSON.stringify(publicToolValue(withFallback(configuration.view))) },
					],
					details: { ...result.details, [OBSERVATION_RESOURCES_DETAIL_KEY]: allowed },
				},
				projectRoot,
			);
			return [
				profile,
				{
					initialResponse,
					fallbackUri: fallback.uri,
					readResource: (uri) => {
						if (
							!allowed.some(
								(descriptor) =>
									uri === descriptor.uri ||
									(descriptor.taskProjection && uri.startsWith(descriptor.uri + "/")),
							)
						)
							throw new Error("Resource was not exposed by this reading configuration");
						return readMcpResource(uri, projectRoot);
					},
				},
			];
		}),
	);
}

/** Observational readiness only: every successful path must pass the same fixture oracle before costs are comparable. */
export async function compareEquivalentNeedCosts(result, projectRoot, contract, budget = NEED_READING_BUDGET) {
	const saved = await savedObservation(result, projectRoot);
	const need = bindTaskNeed(saved.observation, contract);
	const configurations = await readingConfigurations(result, projectRoot, saved);
	const paths = {};
	for (const [profile, configuration] of Object.entries(configurations))
		paths[profile] = await evaluateNeedPath({
			...configuration,
			profile,
			need,
			input: saved.artifact.spec,
			budget,
		});
	const allPathsSatisfied = Object.values(paths).every((entry) => entry.status === "satisfied");
	return {
		comparisonKind: "equivalent-observation-need",
		oracle: TASK_NEED_ORACLE,
		requirement: need.id,
		policy: "public-link-priority-v1",
		snapshotId: need.snapshotId,
		budget,
		unit: "serialized-mcp-response-json-utf8-bytes",
		allPathsSatisfied,
		paths,
		costsAtEqualSufficiency: allPathsSatisfied
			? Object.fromEntries(Object.entries(paths).map(([profile, entry]) => [profile, entry.contextJsonBytes]))
			: null,
		limits: [
			"Fixture-owned observation readiness, not business completion or a model-driven task.",
			"All configurations expose the same immutable evidence fallback; this is an evaluation adapter, not an added default tool or page feature.",
			"Public-link priority is deterministic and not a minimum-read search. Hidden oracle bindings never select a resource.",
			"An oversized response is counted as obtained but not admitted to context or the oracle; that path stops as budget-exhausted.",
			"Setup and server materialization are not model context. Failed reads include a normalized RESOURCE_READ_FAILED response.",
		],
	};
}
