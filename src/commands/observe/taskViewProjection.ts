import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { artifactFallbackName, saveTextArtifact } from "../../artifacts/artifactFiles.js";
import { stableJson } from "../../utils/json.js";
import { projectTaskView } from "../../kernels/abml/taskViewSelection.js";
import { bindTaskRemedies } from "../../kernels/abml/taskEvidence.js";
import {
	TASK_PROJECTION_POLICY,
	TASK_PROJECTION_SCHEMA,
	type DecisionBundle,
	type NormalizedTaskViewSpec,
	type TaskProjectionArtifact,
	type TaskProjectionPlan,
	type TaskPacket,
} from "../../kernels/abml/taskView.js";
import type { PageObservationV3, PageObservationView } from "../../kernels/abml/pageObservation.js";
import {
	OBSERVATION_RESOURCE_URI_PREFIX,
	projectObservationOverflow,
	publicWarnings,
	publicVisual,
	type ObservationResourceDescriptor,
} from "./observationResources.js";

export function taskArtifactHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function taskOutput(plan: TaskProjectionPlan, included: DecisionBundle[], packets: TaskPacket[], compact: boolean) {
	const inlineMandatory = included.filter((bundle) => bundle.mandatory).length;
	return {
		...plan.task,
		observationScope: {
			...plan.task.observationScope,
			collections: compact ? [] : plan.task.observationScope.collections.slice(0, 8),
		},
		outputScope: {
			...plan.task.outputScope,
			groupsInline: included.length,
			groupsFolded: plan.bundles.length - included.length,
			mandatoryGroupsFolded: plan.bundles.filter((bundle) => bundle.mandatory).length - inlineMandatory,
			contextComplete: plan.task.outputScope.contextComplete && included.length === plan.bundles.length,
			packetsInline: packets.length,
			packetsFolded: (plan.packets?.length ?? 0) - packets.length,
		},
	};
}

export function packTaskView(
	observation: PageObservationV3,
	plan: TaskProjectionPlan,
	resourceUri: string,
	canonicalFrontier: NonNullable<PageObservationView["frontier"]>,
	maxBytes = 32 * 1024,
): PageObservationView {
	const included: DecisionBundle[] = [];
	const packets: TaskPacket[] = [];
	const warnings = publicWarnings(observation.diagnostics);
	const title = observation.content?.headings?.[0];
	const build = (compact = false): PageObservationView => ({
		target: {
			...(observation.target.url && observation.target.url.length <= 2048 ? { url: observation.target.url } : {}),
		},
		...(title ? { gist: { title: title.slice(0, 256) } } : {}),
		task: taskOutput(plan, included, packets, compact),
		bundles: [...included],
		...(packets.length ? { packets: [...packets] } : {}),
		...(!compact && warnings.length ? { warnings } : {}),
		frontier: {
			items: [
				{
					ref: "frontier:task-view",
					kind: "details",
					state: "folded",
					label: "Task groups, scope and evidence",
					resourceUri,
					observed: included.length,
					total: plan.bundles.length,
				},
				...canonicalFrontier.items,
			],
		},
	});
	// Fold entire bundles. A control is never copied into an independent action list.
	let foldedMandatory = plan.task.outputScope.mandatoryGroupsUnavailable > 0;
	for (const bundle of plan.bundles) {
		if (foldedMandatory && !bundle.mandatory) continue;
		const relatedPackets = plan.packets?.filter((item) => item.bundleId === bundle.id) ?? [];
		const packetRefs = new Set(relatedPackets.flatMap((packet) => packet.facts.map((fact) => fact.ref)));
		if (
			!bundle.mandatory &&
			relatedPackets.length &&
			(bundle.gapDetails.some((gap) => gap.layer === "selection") || packetRefs.size < bundle.facts.length)
		) {
			for (const packet of relatedPackets) {
				packets.push(packet);
				if (Buffer.byteLength(JSON.stringify(build()), "utf8") > maxBytes) packets.pop();
			}
			continue;
		}
		included.push(bundle);
		const candidate = build();
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) {
			included.pop();
			if (bundle.mandatory) foldedMandatory = true;
			else
				for (const packet of relatedPackets) {
					packets.push(packet);
					if (Buffer.byteLength(JSON.stringify(build()), "utf8") > maxBytes) packets.pop();
				}
		}
	}
	let view = build();
	if (Buffer.byteLength(JSON.stringify(view), "utf8") > maxBytes) {
		included.length = 0;
		packets.length = 0;
		view = build(true);
		view.task!.limitations = [
			...view.task!.limitations,
			"Scope details and warnings are folded into the task resource.",
		];
	}
	// Host-only budgets must accommodate the bounded metadata envelope; never truncate JSON.
	if (Buffer.byteLength(JSON.stringify(view), "utf8") > maxBytes)
		throw new Error("Task view budget cannot contain the minimum identity and scope envelope");
	const visual = publicVisual(observation.visual);
	if (visual) {
		const refs = new Set([...included, ...packets].flatMap((bundle) => bundle.facts.map((item) => item.ref)));
		const candidate = {
			...view,
			visual: { ...visual, targets: visual.targets.filter((target) => refs.has(target.ref)) },
		};
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) view = candidate;
	}
	return view;
}

export async function projectTaskObservation(
	observation: PageObservationV3,
	canonicalPath: string,
	canonicalText: string,
	spec: NormalizedTaskViewSpec,
): Promise<{ observation: PageObservationView; resources: ObservationResourceDescriptor[] }> {
	const plan = projectTaskView(observation, spec);
	const canonical = projectObservationOverflow(observation, canonicalPath);
	const canonicalResource = canonical.resources.find((item) => item.jsonPath === "$")!;
	const evidenceResource: ObservationResourceDescriptor | undefined = [...plan.bundles, ...(plan.packets ?? [])].some(
		(bundle) => bundle.gapDetails.some((gap) => gap.layer === "selection" || gap.layer === "association"),
	)
		? {
				...canonicalResource,
				uri: `${OBSERVATION_RESOURCE_URI_PREFIX}${randomUUID()}`,
				name: "Captured task evidence and typed relationships",
				ref: "frontier:task-evidence",
				jsonPath: undefined,
				taskEvidence: { sha256: taskArtifactHash(canonicalText), policy: TASK_PROJECTION_POLICY },
			}
		: undefined;
	for (const bundle of [...plan.bundles, ...(plan.packets ?? [])])
		bindTaskRemedies(bundle, bundle.id, evidenceResource?.uri);
	const artifact: TaskProjectionArtifact = {
		schema: TASK_PROJECTION_SCHEMA,
		policy: TASK_PROJECTION_POLICY,
		snapshotId: observation.snapshot.snapshotId,
		canonicalSha256: taskArtifactHash(canonicalText),
		capturedAt: observation.snapshot.capturedAt,
		expiresAt: observation.snapshot.capturedAt + observation.snapshot.ttlMs,
		spec,
		...plan,
	};
	const text = stableJson(artifact);
	const filename = artifactFallbackName("observe-task");
	const saved = await saveTextArtifact(undefined, path.join(path.dirname(canonicalPath), filename), filename, text);
	const resource: ObservationResourceDescriptor = {
		uri: `${OBSERVATION_RESOURCE_URI_PREFIX}${randomUUID()}`,
		name: "Task groups and observation boundaries",
		mimeType: "application/json",
		path: saved.path,
		expiresAt: artifact.expiresAt,
		snapshotId: artifact.snapshotId,
		ref: "frontier:task-view",
		kind: "details",
		taskProjection: { sha256: taskArtifactHash(text) },
	};
	const canonicalItem = canonical.observation.frontier!.items.find(
		(item) => item.resourceUri === canonicalResource.uri,
	)!;
	const projected = packTaskView(observation, plan, resource.uri, { items: [canonicalItem] });
	return {
		observation: projected,
		resources: [resource, canonicalResource, ...(evidenceResource ? [evidenceResource] : [])],
	};
}
