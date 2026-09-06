import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { taskEntity, taskObservation } from "../helpers/taskView.ts";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import { packTaskView, taskArtifactHash } from "../../src/commands/observe/taskViewProjection.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import {
	OBSERVATION_RESOURCES_DETAIL_KEY,
	type ObservationResourceDescriptor,
} from "../../src/commands/observe/observationResources.ts";
import { registerMcpObservationResources, readMcpResource, renderMcpToolResult } from "../../src/apps/mcp/server.ts";
import { readTaskProjectionResource } from "../../src/apps/mcp/taskViewResources.ts";
import { isPageObservationView } from "../../src/validation/pageContracts.ts";

function fixture(errorLength = 32) {
	const note = taskEntity("note", "textbox", "Note");
	note.value = "Draft";
	const error = taskEntity("error", "paragraph", "Review required: " + "x".repeat(errorLength));
	note.relations = [{ type: "describedBy", targetRef: error.ref, source: "ax", confidence: "high" }];
	const identity = taskEntity("identity", "heading", "INV-2048");
	const save = taskEntity("save", "button", "Save");
	const other = Array.from({ length: 180 }, (_, i) => taskEntity(`other-${i}`, "textbox", `Optional ${i}`));
	const form = taskEntity("form", "form", "Invoice editor", [identity, ...other, note, save]);
	const observation = taskObservation([form, error]);
	const spec = prepareTaskView({ focus: { refs: [note.ref] }, intent: "interact", fields: ["Note"] })!;
	return { note, error, identity, save, form, observation, spec };
}

test("one field packet retains identity, related error and actions beyond the group selection bound", () => {
	const f = fixture();
	const plan = projectTaskView(f.observation, f.spec);
	const packet = plan.packets![0]!;
	assert.equal(packet.scope.contextComplete, true);
	assert.equal(packet.requirements.local.evidence, "complete");
	assert.equal(plan.bundles[0]!.requirements.identity.delivery, "partial");
	for (const ref of [f.note.ref, f.identity.ref, f.error.ref, f.save.ref, f.form.ref])
		assert.ok(packet.facts.some((fact) => fact.ref === ref));
	assert.ok(!packet.facts.some((fact) => fact.name?.startsWith("Optional")));
	assert.ok(packet.scope.excludedCount >= 180);
	assert.ok(packet.scope.exclusions.every((item) => item.reason));
	const before = JSON.stringify(plan);
	for (const budget of [2500, 12000, 32768]) {
		const view = packTaskView(f.observation, plan, "browser-pilot://observation/example", { items: [] }, budget);
		assert.equal(isPageObservationView(view), true);
		assert.ok(Buffer.byteLength(JSON.stringify(view)) <= budget);
		assert.equal(view.bundles!.length, 0);
		if (budget > 2500) assert.equal(view.packets!.length, 1);
		for (const delivered of view.packets ?? []) assert.deepEqual(delivered, packet);
	}
	assert.equal(JSON.stringify(plan), before);
});

test("a long necessary error folds the whole packet without exposing its controls", () => {
	const f = fixture(50000);
	const plan = projectTaskView(f.observation, f.spec);
	const packet = plan.packets![0]!;
	assert.equal(packet.facts.find((fact) => fact.ref === f.error.ref)!.name, f.error.name);
	assert.equal(packet.scope.contextComplete, true);
	const view = packTaskView(f.observation, plan, "browser-pilot://observation/example", { items: [] });
	assert.equal(view.packets, undefined);
	assert.equal(view.bundles!.length, 0);
	assert.equal(view.actionSpace, undefined);
	assert.equal(view.task!.outputScope.packetsFolded, 1);
});

test("packet independence does not repair missing capture or uncertain sibling ownership", () => {
	const f = fixture();
	f.observation.entities = [f.form];
	const packet = projectTaskView(f.observation, f.spec).packets![0]!;
	assert.equal(packet.scope.contextComplete, false);
	assert.ok(packet.gapDetails.some((gap) => gap.layer === "capture"));
	const local = taskEntity("local", "group", "Fields", [f.note]);
	const sibling = taskEntity("sibling", "group", "Actions", [f.save]);
	f.form.children = [f.identity, local, sibling];
	f.observation.entities = [f.form, f.error];
	const uncertain = projectTaskView(f.observation, f.spec).packets![0]!;
	assert.equal(uncertain.requirements.actions.evidence, "unknown");
	assert.ok(!uncertain.facts.some((fact) => fact.ref === f.save.ref));
	assert.ok(uncertain.gapDetails.some((gap) => gap.layer === "association"));
});

async function read(uri: string, cwd: string) {
	const response = await readMcpResource(uri, cwd);
	const item = response.contents[0]!;
	assert.ok("text" in item);
	return { value: JSON.parse(item.text) as any, bytes: Buffer.byteLength(item.text) };
}

test("packet resources keep complete historical dependencies, exact sizes and v2 group compatibility", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-packets-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const f = fixture(50000);
	const result = await pageObservationResult({
		observation: f.observation,
		view: f.spec,
		ctx: { cwd },
		fallbackName: "packets.json",
	});
	registerMcpObservationResources(result.details, cwd);
	const descriptor = (result.details![OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[]).find(
		(r) => r.taskProjection,
	)!;
	const index = (await read(descriptor.uri, cwd)).value;
	const entry = index.packetIndex.packets[0];
	assert.equal(entry.contextComplete, true);
	assert.equal(entry.requirements.local.delivery, "folded");
	const expanded = await read(entry.resourceUri, cwd);
	assert.equal(expanded.bytes, entry.resourceJsonBytes);
	assert.equal(expanded.value.packet.facts.find((fact: any) => fact.ref === f.error.ref).name, f.error.name);
	f.note.value = "Changed after capture";
	assert.deepEqual(await read(entry.resourceUri, cwd), expanded);
	assert.equal(expanded.value.packet.scope.snapshotId, expanded.value.snapshotId);
	await assert.rejects(read(`${descriptor.uri}/packets/999`, cwd), /unavailable/);
	await assert.rejects(read(`${descriptor.uri}/packet-index/999`, cwd), /unavailable/);
	const presentation = renderMcpToolResult("browser_observe", result, cwd);
	const text = presentation.content.find((item) => item.type === "text")!;
	assert.ok(text.type === "text");
	assert.deepEqual(JSON.parse(text.text), presentation.structuredContent);
	const v2 = JSON.parse(await readFile(descriptor.path, "utf8"));
	v2.schema = "browser-task-projection/v2";
	v2.policy = "literal-context-v2";
	delete v2.packets;
	const saved = JSON.stringify(v2);
	const legacyDescriptor = { ...descriptor, taskProjection: { sha256: taskArtifactHash(saved) } };
	const group = readTaskProjectionResource(saved, legacyDescriptor, `${descriptor.uri}/groups/0`) as any;
	assert.deepEqual(group.bundle, v2.bundles[0]);
	assert.throws(
		() => readTaskProjectionResource(saved, legacyDescriptor, `${descriptor.uri}/packets/0`),
		/unavailable/,
	);
});

test("packet index pagination enumerates every saved packet without duplicating a subject", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-packet-pages-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const fields = Array.from({ length: 20 }, (_, i) => taskEntity(`note-${i}`, "textbox", "Note"));
	const owner = taskEntity("owner", "form", "INV-2048", fields);
	const result = await pageObservationResult({
		observation: taskObservation([owner]),
		view: prepareTaskView({ focus: { refs: [owner.ref] }, fields: ["Note"] }),
		ctx: { cwd },
		fallbackName: "index.json",
	});
	registerMcpObservationResources(result.details, cwd);
	const descriptor = (result.details![OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[]).find(
		(r) => r.taskProjection,
	)!;
	const index = (await read(descriptor.uri, cwd)).value;
	const first = index.packetIndex;
	assert.equal(first.packets.length, 16);
	const second = (await read(first.nextUri, cwd)).value;
	assert.equal(second.packets.length, 4);
	assert.equal(second.nextUri, undefined);
	assert.equal(new Set([...first.packets, ...second.packets].map((item) => item.subjectRef)).size, 20);
});

test("oversized dependency sets are unavailable and do not advertise a folded packet", () => {
	const f = fixture();
	(f.form.children as any[]).push(
		...Array.from({ length: 140 }, (_, i) => taskEntity(`identity-${i}`, "cell", `Value ${i}`)),
	);
	const plan = projectTaskView(f.observation, f.spec);
	assert.equal(plan.packets!.length, 0);
	assert.equal(plan.task.outputScope.packetsUnavailable, 1);
	assert.equal(plan.task.outputScope.packetsFolded, 0);
});
