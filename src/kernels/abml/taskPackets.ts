import type { Entity } from "./entity.js";
import type { PageObservationV3 } from "./pageObservation.js";
import { taskContext, taskRelations, type TaskEntityIndex } from "./taskViewGraph.js";
import { assessTaskContext, planOwnerContext } from "./taskContextCoverage.js";
import { taskObjectRoot } from "./taskViewGraph.js";
import { bindTaskRemedies, retainTaskEvidence } from "./taskEvidence.js";
import {
	normalizeTaskText,
	type DecisionBundle,
	type NormalizedTaskViewSpec,
	type TaskPacket,
	type TaskGap,
} from "./taskView.js";
import { taskFact } from "./taskViewSelection.js";
import { taskRelationEvidence, taskIdentityFields } from "./taskOwnership.js";

const MAX_PACKETS = 256;
const MAX_DEPENDENCIES = 128;
const DEPENDENCIES = new Set(["labelledBy", "describedBy", "columnOf", "coveredBy", "controls", "expandedTarget"]);

function packetSubjects(entities: Entity[], bundle: DecisionBundle, spec: NormalizedTaskViewSpec): Entity[] {
	return entities.filter((entity) => {
		if (!entity.state.editable && !entity.actionability?.actions.length) return false;
		if ("refs" in spec.focus && entity.ref === bundle.anchor.ref) return true;
		return (
			entity.state.editable &&
			spec.fields.some((field) => normalizeTaskText(entity.name ?? "").includes(normalizeTaskText(field)))
		);
	});
}

/** Fixed policy: owner and captured static identification fields, subject, owner actions, and typed dependencies. */
function packetMembers(index: TaskEntityIndex, subject: Entity, candidates: Entity[]) {
	const ownerPlan = planOwnerContext(index, taskObjectRoot(index, subject), subject);
	const identity = taskIdentityFields(index, candidates, ownerPlan.owner);
	const labels = new Set(
		candidates.flatMap((entity) =>
			taskRelations(entity)
				.filter((edge) => edge.type === "labelledBy")
				.map((edge) => edge.targetRef),
		),
	);
	const members = new Map(
		[
			subject,
			...identity,
			...candidates.filter(
				(entity) =>
					(entity.actionability?.actions.includes("click") && !labels.has(entity.ref)) ||
					["alert", "status", "alertdialog"].includes(entity.role.toLowerCase()),
			),
		].map((entity) => [entity.ref, entity]),
	);
	const missing: string[] = [];
	const pending = [...members.values()];
	for (let i = 0; i < pending.length; i++) {
		for (const relation of taskRelations(pending[i]!)) {
			if (!DEPENDENCIES.has(relation.type) || members.has(relation.targetRef)) continue;
			const target = index.byRef.get(relation.targetRef);
			if (!target) {
				missing.push(relation.targetRef);
				continue;
			}
			members.set(target.ref, target);
			pending.push(target);
		}
	}
	return { ownerPlan, identity, members, missing };
}

function createPacket(
	index: TaskEntityIndex,
	bundle: DecisionBundle,
	subject: Entity,
	candidates: Entity[],
	snapshotId: string,
	spec: NormalizedTaskViewSpec,
): TaskPacket | undefined {
	const { ownerPlan, identity, members, missing } = packetMembers(index, subject, candidates);
	if (members.size > MAX_DEPENDENCIES) return undefined;
	const refs = [...members.keys()];
	const issues: Array<Omit<TaskGap, "id" | "remedyIds">> = [];
	const incomplete = [...members.values()].filter(
		(entity) =>
			(entity.children && !Array.isArray(entity.children)) ||
			entity.hints?.contextTextIncomplete === true ||
			entity.hints?.contextRelationsIncomplete === true,
	);
	if (!index.complete)
		issues.push({
			code: "entity-index-limit",
			requirement: "local",
			layer: "selection",
			relatedRefs: [],
			reason: "The bounded index did not inspect the entire canonical snapshot.",
		});
	if (missing.length)
		issues.push({
			code: "packet-dependency-unavailable",
			requirement: "local",
			layer: index.complete ? "capture" : "selection",
			relatedRefs: missing,
			reason: "Required relation targets are unavailable in the inspected snapshot scope.",
		});
	if (incomplete.length)
		issues.push({
			code: "packet-dependency-unavailable",
			requirement: "local",
			layer: "capture",
			relatedRefs: incomplete.map((entity) => entity.ref),
			reason: "Required captured context is explicitly incomplete.",
		});
	const evidence = assessTaskContext({
		anchor: subject,
		localRefs: new Set(refs),
		candidates: members,
		ownerPlan,
		intent: spec.intent,
		focused: true,
		issues,
	});
	retainTaskEvidence(evidence, new Set(refs));
	const excluded = candidates.filter((entity) => !members.has(entity.ref));
	return {
		...evidence,
		id: "",
		bundleId: bundle.id,
		kind: subject.state.editable ? "field" : "context",
		packetKind: subject.state.editable ? "field" : "action",
		question: `${subject.name ?? subject.role} context`,
		anchor: { ref: subject.ref, role: subject.role, ...(subject.name ? { name: subject.name } : {}) },
		candidate: true,
		mandatory: bundle.mandatory,
		reasons: ["field-context-v2"],
		relationEvidence: taskRelationEvidence(index, new Set(refs), snapshotId),
		facts: [...members.values()].map((entity) => taskFact(entity, true, evidence, Infinity)),
		matches: bundle.matches.filter((match) => match.ref && members.has(match.ref)),
		changes: bundle.changes.filter((change) => members.has(change.ref)),
		scope: {
			policy: "field-context-v2",
			snapshotId,
			subjectRef: subject.ref,
			...(ownerPlan.owner ? { ownerRef: ownerPlan.owner.ref } : {}),
			identityRefs: identity.map((entity) => entity.ref),
			dependencyRefs: refs,
			contextComplete: evidence.gapDetails.length === 0,
			excludedCount: excluded.length,
			exclusions: excluded.slice(0, 16).map((entity) => ({
				ref: entity.ref,
				reason: "Outside the subject, captured identification fields, owner actions and typed dependency closure.",
			})),
		},
	};
}

export function planTaskPackets(
	index: TaskEntityIndex,
	bundles: DecisionBundle[],
	spec: NormalizedTaskViewSpec,
	observation: PageObservationV3,
): { packets: TaskPacket[]; unavailable: number } {
	const packets: TaskPacket[] = [];
	let unavailable = 0;
	let attempted = 0;
	for (const bundle of bundles) {
		const anchor = bundle.anchor.ref ? index.byRef.get(bundle.anchor.ref) : undefined;
		if (!bundle.candidate || !anchor || bundle.mandatory) continue;
		const context = taskContext(index, anchor, { spec, matchedRefs: new Set(), changedRefs: new Set() });
		for (const subject of packetSubjects(context.candidates, bundle, spec)) {
			if (attempted++ >= MAX_PACKETS) {
				unavailable++;
				continue;
			}
			const subjectContext = taskContext(index, subject, {
				spec,
				matchedRefs: new Set(),
				changedRefs: new Set(),
			});
			const packet =
				packets.length < MAX_PACKETS
					? createPacket(
							index,
							bundle,
							subject,
							subjectContext.candidates,
							observation.snapshot.snapshotId,
							spec,
						)
					: undefined;
			if (!packet) {
				unavailable++;
				continue;
			}
			packet.id = `task-packet-${packets.length + 1}`;
			bindTaskRemedies(packet, packet.id);
			packets.push(packet);
		}
	}
	return { packets, unavailable };
}
