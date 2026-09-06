import assert from "node:assert/strict";
import test from "node:test";
import { taskEvidenceScenario } from "../helpers/taskEvidenceScenario.ts";
import { taskEntity } from "../helpers/taskView.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import { packTaskView, taskArtifactHash } from "../../src/commands/observe/taskViewProjection.ts";
import { readTaskProjectionResource } from "../../src/apps/mcp/taskViewResources.ts";
import {
	TASK_PROJECTION_SCHEMA,
	TASK_PROJECTION_POLICY,
	type TaskEvidence,
	type DecisionBundle,
	type TaskProjectionArtifact,
	type TaskPacket,
} from "../../src/kernels/abml/taskView.ts";
import type { ObservationResourceDescriptor } from "../../src/commands/observe/observationResources.ts";
import { isPageObservationView } from "../../src/validation/pageContracts.ts";
import { renderMcpToolResult } from "../../src/apps/mcp/server.ts";

const kinds = ["local", "owner", "identity", "actions"] as const;
const evidenceStates = (item: TaskEvidence) =>
	Object.fromEntries(kinds.map((kind) => [kind, item.requirements[kind].evidence]));

for (const wrapped of [false, true])
	for (const external of [false, true])
		for (const otherRecord of [false, true])
			for (const ownership of ["proven", "removed", "conflicting"] as const)
				for (const missingDescription of [false, true]) {
					test(`cross-layer evidence: ${JSON.stringify({ wrapped, external, otherRecord, ownership, missingDescription })}`, () => {
						const f = taskEvidenceScenario({
							wrapped,
							external,
							otherRecord,
							ownership,
							missingDescription,
						});
						const plan = projectTaskView(f.observation, f.spec);
						const bundle = plan.bundles.find((item) => item.candidate)!;
						const packet = plan.packets!.find((item) => item.scope.subjectRef === f.note.ref)!;
						const expected = {
							local: missingDescription ? "incomplete" : "complete",
							owner: "complete",
							identity:
								ownership !== "proven" ? "unknown" : missingDescription ? "incomplete" : "complete",
							actions:
								ownership !== "proven" ? "unknown" : missingDescription ? "incomplete" : "complete",
						};
						assert.deepEqual(
							evidenceStates(bundle),
							expected,
							"bundle must respect the fixture's independent evidence oracle",
						);
						assert.deepEqual(
							evidenceStates(packet),
							expected,
							"packet cannot restore missing evidence through a different evaluator",
						);
						for (const item of [bundle, packet]) {
							assert.ok(
								item.facts.some((fact) => fact.ref === f.identity.ref && fact.name === "INV-2048"),
							);
							assert.ok(item.facts.some((fact) => fact.ref === f.note.ref && fact.value === "Draft"));
							assert.ok(!item.facts.some((fact) => fact.ref.includes("other")));
							if (!missingDescription)
								assert.ok(
									item.facts.some(
										(fact) => fact.ref === f.description.ref && fact.name === f.description.name,
									),
								);
							if (ownership === "proven") assert.ok(item.facts.some((fact) => fact.ref === f.save.ref));
						}
						const saved = JSON.stringify(plan);
						for (const budget of [2500, 12000, 32768]) {
							const view = packTaskView(
								f.observation,
								plan,
								"browser-pilot://observation/invariants",
								{ items: [] },
								budget,
							);
							assert.equal(isPageObservationView(view), true);
							assert.ok(Buffer.byteLength(JSON.stringify(view)) <= budget);
							const presentation = renderMcpToolResult(
								"browser_observe",
								{
									content: [{ type: "text", text: JSON.stringify(view) }],
								},
								process.cwd(),
							);
							const content = presentation.content.find((item) => item.type === "text")!;
							assert.ok(content.type === "text");
							assert.deepEqual(JSON.parse(content.text), presentation.structuredContent);
							for (const item of [...view.bundles!, ...(view.packets ?? [])])
								assert.deepEqual(evidenceStates(item), expected);
						}
						assert.equal(JSON.stringify(plan), saved, "packing must not mutate the saved evidence plan");
						const artifact: TaskProjectionArtifact = {
							...plan,
							schema: TASK_PROJECTION_SCHEMA,
							policy: TASK_PROJECTION_POLICY,
							snapshotId: f.observation.snapshot.snapshotId,
							canonicalSha256: taskArtifactHash(JSON.stringify(f.observation)),
							capturedAt: 1000,
							expiresAt: 61000,
							spec: f.spec,
						};
						const text = JSON.stringify(artifact);
						const descriptor: ObservationResourceDescriptor = {
							uri: "browser-pilot://observation/invariants",
							name: "test",
							mimeType: "application/json",
							path: "unused",
							snapshotId: artifact.snapshotId,
							expiresAt: artifact.expiresAt,
							ref: "frontier:task-view",
							kind: "details",
							taskProjection: { sha256: taskArtifactHash(text) },
						};
						const read = (suffix: string) =>
							readTaskProjectionResource(text, descriptor, descriptor.uri + suffix);
						const index = read("") as { groups: TaskEvidence[]; packetIndex: { packets: TaskEvidence[] } };
						const expanded = read("/groups/0") as { bundle: DecisionBundle };
						const expandedPacket = read("/packets/0") as { packet: TaskPacket };
						for (const item of [
							index.groups[0]!,
							index.packetIndex.packets[0]!,
							expanded.bundle,
							expandedPacket.packet,
						])
							assert.deepEqual(evidenceStates(item), expected);
						assert.deepEqual(expanded.bundle, bundle);
						assert.deepEqual(expandedPacket.packet, packet);
						f.note.value = "Later live value";
						assert.deepEqual(read("/packets/0"), expandedPacket);
					});
				}

test("a missing description on an excluded field does not poison a complete Note packet", () => {
	const f = taskEvidenceScenario();
	const other = taskEntity("unrelated-input", "textbox", "Other field");
	other.hints = { contextParentRef: f.owner.ref };
	other.relations = [
		{ type: "describedBy", targetRef: "bp-ref://region/uncaptured-other-help", source: "ax", confidence: "high" },
	];
	f.entities.push(other);
	const plan = projectTaskView(f.observation, f.spec);
	assert.equal(plan.bundles[0]!.requirements.local.evidence, "incomplete");
	assert.ok(plan.packets![0]!.scope.contextComplete);
	assert.ok(!plan.packets![0]!.facts.some((fact) => fact.ref === other.ref));
});

test("equivalent read scopes agree that action requirements are not applicable", () => {
	const f = taskEvidenceScenario();
	f.note.state.editable = false;
	f.note.actionability = { actions: ["click"], confidence: "high" };
	const plan = projectTaskView(f.observation, { ...f.spec, intent: "read" });
	assert.equal(plan.bundles[0]!.requirements.actions.evidence, "not-applicable");
	assert.equal(plan.packets![0]!.requirements.actions.evidence, "not-applicable");
});

test("identical dependencies preserve the same combined missing-capture and missing-owner verdict", () => {
	const f = taskEvidenceScenario();
	f.observation.entities = [f.note];
	const plan = projectTaskView(f.observation, f.spec);
	const bundle = plan.bundles[0]!;
	const packet = plan.packets![0]!;
	for (const kind of kinds)
		assert.deepEqual(
			new Set(bundle.requirements[kind].evidenceRefs),
			new Set(packet.requirements[kind].evidenceRefs),
		);
	assert.deepEqual(evidenceStates(packet), evidenceStates(bundle));
	assert.equal(packet.requirements.local.evidence, "incomplete");
	assert.equal(packet.requirements.actions.evidence, "unknown");
});

test("a child's native association cannot discharge its parent's unproven action ownership", () => {
	const f = taskEvidenceScenario({ ownership: "removed" });
	const child = taskEntity("nested-native-action", "button", "Child action");
	child.hints = { contextParentRef: f.save.ref };
	child.relations = [
		{
			type: "formOwner",
			targetRef: f.owner.ref,
			source: "dom",
			confidence: "high",
			evidence: { basis: "native-association" },
		},
	];
	f.entities.push(child);
	const plan = projectTaskView(f.observation, f.spec);
	for (const item of [plan.bundles[0]!, plan.packets![0]!]) {
		assert.equal(item.requirements.actions.evidence, "unknown");
		assert.ok(item.gapDetails.some((gap) => gap.layer === "association" && gap.relatedRefs.includes(f.save.ref)));
	}
});

for (const separateScope of ["target", "record"])
	test(`an unproven native claim in another ${separateScope} does not taint the Note scope`, () => {
		const f = taskEvidenceScenario();
		const unrelated = taskEntity("unproven-other-action", "button", "Other action");
		unrelated.hints = { formOwnerObserved: true, formOwnerSelector: "#invoice" };
		if (separateScope === "target") unrelated.hints.targetId = "other-frame";
		else {
			const row = taskEntity("unproven-other-record", "row", "Other record");
			row.hints = { contextParentRef: f.owner.ref };
			unrelated.hints.contextParentRef = row.ref;
			f.entities.push(row);
		}
		f.entities.push(unrelated);
		const plan = projectTaskView(f.observation, f.spec);
		assert.equal(plan.packets![0]!.requirements.actions.evidence, "complete");
		assert.equal(plan.bundles[0]!.requirements.actions.evidence, "complete");
		assert.ok(!plan.packets![0]!.facts.some((fact) => fact.ref === unrelated.ref));
	});
