import { Value } from "typebox/value";
import { TASK_PROJECTION_ARTIFACT_SCHEMA } from "../../kernels/abml/taskViewSchema.js";
import type { TaskProjectionArtifact } from "../../kernels/abml/taskView.js";
import type { ObservationResourceDescriptor } from "../../commands/observe/observationResources.js";
import { taskArtifactHash } from "../../commands/observe/taskViewProjection.js";

const INDEX_PAGE_SIZE = 16;

export function validTaskResourceDescriptor(descriptor: ObservationResourceDescriptor): boolean {
	return (
		descriptor.kind === "details" &&
		descriptor.jsonPath === undefined &&
		descriptor.contentSection === undefined &&
		!!descriptor.taskProjection &&
		typeof descriptor.taskProjection.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(descriptor.taskProjection.sha256)
	);
}

/** A derived URI addresses one group or one bounded index page under the registered snapshot token. */
export function taskResourceSuffix(
	uri: string,
): { base: string; kind: "index" | "groups" | "scope"; index: number } | undefined {
	const match = /^(.*)\/(index|groups|scope)\/(0|[1-9][0-9]{0,5})$/.exec(uri);
	return match
		? { base: match[1]!, kind: match[2] as "index" | "groups" | "scope", index: Number(match[3]) }
		: undefined;
}

export function readTaskProjectionResource(
	text: string,
	descriptor: ObservationResourceDescriptor,
	uri: string,
): unknown {
	if (!validTaskResourceDescriptor(descriptor) || taskArtifactHash(text) !== descriptor.taskProjection!.sha256)
		throw new Error("Task projection resource digest mismatch");
	const parsed: unknown = JSON.parse(text);
	if (!Value.Check(TASK_PROJECTION_ARTIFACT_SCHEMA, parsed)) throw new Error("Invalid task projection artifact");
	const artifact = parsed as TaskProjectionArtifact;
	if (artifact.snapshotId !== descriptor.snapshotId || artifact.expiresAt !== descriptor.expiresAt)
		throw new Error("Task projection snapshot mismatch");
	const selector = taskResourceSuffix(uri);
	if (selector?.base !== undefined && selector.base !== descriptor.uri) throw new Error("Invalid task resource URI");
	if (selector?.kind === "groups") {
		const group = artifact.bundles[selector.index];
		if (!group) throw new Error("Task group is unavailable");
		return {
			capturedAt: artifact.capturedAt,
			task: resourceTask(artifact, 1, group.mandatory ? 1 : 0),
			bundle: group,
		};
	}
	if (selector?.kind === "scope") {
		if (selector.index !== 0) throw new Error("Task scope page is unavailable");
		return { capturedAt: artifact.capturedAt, task: resourceTask(artifact, 0, 0) };
	}
	const page = selector?.index ?? 0;
	const start = page * INDEX_PAGE_SIZE;
	if (page && start >= artifact.bundles.length) throw new Error("Task index page is unavailable");
	return {
		capturedAt: artifact.capturedAt,
		task: {
			...resourceTask(artifact, 0, 0),
			observationScope: {
				...artifact.task.observationScope,
				collections: artifact.task.observationScope.collections.slice(0, 8),
			},
		},
		scopeUri: `${descriptor.uri}/scope/0`,
		groups: artifact.bundles.slice(start, start + INDEX_PAGE_SIZE).map((bundle, offset) => ({
			id: bundle.id,
			kind: bundle.kind,
			anchor: { ...bundle.anchor, ...(bundle.anchor.name ? { name: bundle.anchor.name.slice(0, 160) } : {}) },
			...(bundle.anchor.name && bundle.anchor.name.length > 160 ? { anchorNameTruncated: true } : {}),
			candidate: bundle.candidate,
			mandatory: bundle.mandatory,
			factCount: bundle.facts.length,
			gaps: bundle.gaps,
			resourceUri: `${descriptor.uri}/groups/${start + offset}`,
		})),
		...(start + INDEX_PAGE_SIZE < artifact.bundles.length
			? { nextUri: `${descriptor.uri}/index/${page + 1}` }
			: {}),
	};
}

function resourceTask(artifact: TaskProjectionArtifact, inline: number, mandatoryInline: number) {
	return {
		...artifact.task,
		outputScope: {
			...artifact.task.outputScope,
			groupsInline: inline,
			groupsFolded: artifact.task.outputScope.groupsTotal - inline,
			mandatoryGroupsFolded: artifact.task.outputScope.mandatoryGroups - mandatoryInline,
			contextComplete: artifact.task.outputScope.contextComplete && inline === artifact.bundles.length,
		},
	};
}
