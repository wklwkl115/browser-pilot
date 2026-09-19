import { Value } from "typebox/value";
import {
	TASK_PROJECTION_ARTIFACT_SCHEMA,
	LEGACY_TASK_PROJECTION_ARTIFACT_SCHEMA,
	V2_TASK_PROJECTION_ARTIFACT_SCHEMA,
	V3_TASK_PROJECTION_ARTIFACT_SCHEMA,
} from "../../kernels/abml/taskViewSchema.js";
import { foldedTaskEvidence } from "../../kernels/abml/taskEvidence.js";
import { TASK_PROJECTION_POLICY, type TaskProjectionArtifact, type TaskPacket } from "../../kernels/abml/taskView.js";
import { taskSnapshotEvidence } from "../../kernels/abml/taskViewSelection.js";
import { isPageObservationV3 } from "../../validation/pageContracts.js";
import type { ObservationResourceDescriptor } from "../../commands/observe/observationResources.js";
import { taskArtifactHash } from "../../commands/observe/taskViewProjection.js";

const INDEX_PAGE_SIZE = 16;

export function validTaskEvidenceDescriptor(descriptor: ObservationResourceDescriptor): boolean {
	return (
		descriptor.kind === "details" &&
		descriptor.jsonPath === undefined &&
		descriptor.contentSection === undefined &&
		descriptor.taskProjection === undefined &&
		[TASK_PROJECTION_POLICY, "literal-context-v2", "literal-context-v3"].includes(
			descriptor.taskEvidence?.policy ?? "",
		) &&
		typeof descriptor.taskEvidence?.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(descriptor.taskEvidence.sha256)
	);
}

export function readTaskEvidenceResource(text: string, descriptor: ObservationResourceDescriptor): unknown {
	if (!validTaskEvidenceDescriptor(descriptor) || taskArtifactHash(text) !== descriptor.taskEvidence!.sha256)
		throw new Error("Task evidence resource digest or policy mismatch");
	const observation: unknown = JSON.parse(text);
	if (
		!isPageObservationV3(observation) ||
		observation.snapshot.snapshotId !== descriptor.snapshotId ||
		observation.snapshot.capturedAt + observation.snapshot.ttlMs !== descriptor.expiresAt
	)
		throw new Error("Task evidence snapshot mismatch");
	return taskSnapshotEvidence(observation);
}

export function validTaskResourceDescriptor(descriptor: ObservationResourceDescriptor): boolean {
	return (
		descriptor.kind === "details" &&
		descriptor.jsonPath === undefined &&
		descriptor.contentSection === undefined &&
		descriptor.taskEvidence === undefined &&
		!!descriptor.taskProjection &&
		typeof descriptor.taskProjection.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(descriptor.taskProjection.sha256)
	);
}

/** A derived URI addresses one group or one bounded index page under the registered snapshot token. */
export function taskResourceSuffix(
	uri: string,
): { base: string; kind: "index" | "groups" | "scope" | "packets" | "packet-index"; index: number } | undefined {
	const match = /^(.*)\/(index|groups|scope|packets|packet-index)\/(0|[1-9][0-9]{0,5})$/.exec(uri);
	return match
		? {
				base: match[1]!,
				kind: match[2] as "index" | "groups" | "scope" | "packets" | "packet-index",
				index: Number(match[3]),
			}
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
	if (
		!Value.Check(TASK_PROJECTION_ARTIFACT_SCHEMA, parsed) &&
		!Value.Check(V2_TASK_PROJECTION_ARTIFACT_SCHEMA, parsed) &&
		!Value.Check(V3_TASK_PROJECTION_ARTIFACT_SCHEMA, parsed) &&
		!Value.Check(LEGACY_TASK_PROJECTION_ARTIFACT_SCHEMA, parsed)
	)
		throw new Error("Invalid task projection artifact");
	const artifact = parsed as TaskProjectionArtifact;
	if (artifact.snapshotId !== descriptor.snapshotId || artifact.expiresAt !== descriptor.expiresAt)
		throw new Error("Task projection snapshot mismatch");
	const selector = taskResourceSuffix(uri);
	if (selector?.base !== undefined && selector.base !== descriptor.uri) throw new Error("Invalid task resource URI");
	if (selector?.kind === "packets") {
		const packet = artifact.packets?.[selector.index];
		if (!packet) throw new Error("Task packet is unavailable");
		return packetResource(artifact, packet);
	}
	if (selector?.kind === "packet-index") {
		if (!artifact.packets || (selector.index && selector.index * INDEX_PAGE_SIZE >= artifact.packets.length))
			throw new Error("Task packet index is unavailable");
		return packetIndex(artifact, descriptor.uri, selector.index);
	}
	if (selector?.kind === "groups") {
		const group = artifact.bundles[selector.index];
		if (!group) throw new Error("Task group is unavailable");
		return groupResource(artifact, group);
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
		...(artifact.packets ? { packetIndex: packetIndex(artifact, descriptor.uri, 0) } : {}),
		groups: artifact.bundles.slice(start, start + INDEX_PAGE_SIZE).map((bundle, offset) => ({
			id: bundle.id,
			kind: bundle.kind,
			anchor: { ...bundle.anchor, ...(bundle.anchor.name ? { name: bundle.anchor.name.slice(0, 160) } : {}) },
			...(bundle.anchor.name && bundle.anchor.name.length > 160 ? { anchorNameTruncated: true } : {}),
			candidate: bundle.candidate,
			mandatory: bundle.mandatory,
			factCount: bundle.facts.length,
			resourceJsonBytes: Buffer.byteLength(JSON.stringify(groupResource(artifact, bundle))),
			exceedsInlineBudget: Buffer.byteLength(JSON.stringify(groupResource(artifact, bundle))) > 32 * 1024,
			gaps: bundle.gaps,
			...(bundle.requirements
				? foldedTaskEvidence(bundle, bundle.id, `${descriptor.uri}/groups/${start + offset}`)
				: {}),
			resourceUri: `${descriptor.uri}/groups/${start + offset}`,
		})),
		...(start + INDEX_PAGE_SIZE < artifact.bundles.length
			? { nextUri: `${descriptor.uri}/index/${page + 1}` }
			: {}),
	};
}

function packetResource(artifact: TaskProjectionArtifact, packet: TaskPacket) {
	return {
		schema: artifact.schema,
		policy: artifact.policy,
		snapshotId: artifact.snapshotId,
		canonicalSha256: artifact.canonicalSha256,
		capturedAt: artifact.capturedAt,
		expiresAt: artifact.expiresAt,
		task: {
			...resourceTask(artifact, 0, 0),
			outputScope: {
				...resourceTask(artifact, 0, 0).outputScope,
				packetsInline: 1,
				packetsFolded: (artifact.packets?.length ?? 0) - 1,
			},
		},
		packet,
	};
}

function packetIndex(artifact: TaskProjectionArtifact, baseUri: string, page: number) {
	const packets = artifact.packets ?? [];
	const start = page * INDEX_PAGE_SIZE;
	return {
		resourceUri: `${baseUri}/packet-index/${page}`,
		packets: packets.slice(start, start + INDEX_PAGE_SIZE).map((packet, offset) => ({
			id: packet.id,
			bundleId: packet.bundleId,
			question: packet.question,
			packetKind: packet.packetKind,
			subjectRef: packet.scope.subjectRef,
			ownerRef: packet.scope.ownerRef,
			contextComplete: packet.scope.contextComplete,
			factCount: packet.facts.length,
			...foldedTaskEvidence(packet, packet.id, `${baseUri}/packets/${start + offset}`),
			resourceUri: `${baseUri}/packets/${start + offset}`,
			resourceJsonBytes: Buffer.byteLength(JSON.stringify(packetResource(artifact, packet))),
		})),
		...(start + INDEX_PAGE_SIZE < packets.length ? { nextUri: `${baseUri}/packet-index/${page + 1}` } : {}),
	};
}

function groupResource(artifact: TaskProjectionArtifact, bundle: TaskProjectionArtifact["bundles"][number]) {
	return {
		capturedAt: artifact.capturedAt,
		task: resourceTask(artifact, 1, bundle.mandatory ? 1 : 0),
		bundle,
	};
}

function resourceTask(artifact: TaskProjectionArtifact, inline: number, mandatoryInline: number) {
	return {
		...artifact.task,
		outputScope: {
			...artifact.task.outputScope,
			groupsInline: inline,
			groupsFolded:
				artifact.task.outputScope.groupsTotal - (artifact.task.outputScope.groupsUnavailable ?? 0) - inline,
			mandatoryGroupsFolded:
				artifact.task.outputScope.mandatoryGroups -
				(artifact.task.outputScope.mandatoryGroupsUnavailable ?? 0) -
				mandatoryInline,
			contextComplete: artifact.task.outputScope.contextComplete && inline === artifact.bundles.length,
			...(artifact.packets ? { packetsInline: 0, packetsFolded: artifact.packets.length } : {}),
		},
	};
}
