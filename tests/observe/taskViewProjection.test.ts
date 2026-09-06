import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { taskEntity, taskInvoice, taskObservation } from "../helpers/taskView.ts";
import { prepareTaskView } from "../../src/commands/observe/taskViewInput.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import { packTaskView, taskArtifactHash } from "../../src/commands/observe/taskViewProjection.ts";
import { projectTaskView } from "../../src/kernels/abml/taskViewSelection.ts";
import {
	OBSERVATION_RESOURCES_DETAIL_KEY,
	type ObservationResourceDescriptor,
} from "../../src/commands/observe/observationResources.ts";
import { readMcpResource, registerMcpObservationResources, renderMcpToolResult } from "../../src/apps/mcp/server.ts";
import { isPageObservationView } from "../../src/validation/pageContracts.ts";
import type { PageObservationView } from "../../src/kernels/abml/pageObservation.ts";

function resourceText(value: Awaited<ReturnType<typeof readMcpResource>>) {
	const first = value.contents[0]!;
	assert.ok("text" in first);
	return JSON.parse(first.text) as Record<string, any>;
}

test("task output preserves canonical facts, expands a historical group and validates output schema", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-task-view-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const invoice = taskInvoice();
	const observation = taskObservation([invoice.record]);
	const before = JSON.parse(JSON.stringify(observation));
	const canonicalPath = path.join(cwd, ".browser-pilot", "artifacts", "canonical.json");
	const result = await pageObservationResult({
		observation,
		artifactPath: canonicalPath,
		fallbackName: "canonical.json",
		ctx: { cwd },
		view: prepareTaskView({ focus: { refs: [invoice.record.ref] }, intent: "interact", fields: ["备注"] }),
	});
	const view = JSON.parse(result.content[0]!.text) as PageObservationView;
	assert.equal(isPageObservationView(view), true);
	const presentation = renderMcpToolResult("browser_observe", result, cwd);
	const textOnly = presentation.content.find((item) => item.type === "text")!;
	assert.ok(textOnly.type === "text");
	assert.deepEqual(JSON.parse(textOnly.text), presentation.structuredContent);
	assert.deepEqual(JSON.parse(await readFile(canonicalPath, "utf8")), before);
	const resources = result.details![OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];
	assert.equal(registerMcpObservationResources(result.details, cwd).length, 2);
	const task = resources.find((item) => item.taskProjection)!;
	const index = resourceText(await readMcpResource(task.uri, cwd));
	assert.equal(index.groups[0].anchor.name, "INV-2048");
	invoice.note.value = "later page value";
	const group = resourceText(await readMcpResource(index.groups[0].resourceUri, cwd));
	assert.ok(group.bundle.facts.some((fact: { value?: string }) => fact.value === "已联系客户"));
	assert.ok(!JSON.stringify(group).includes("later page value"));
	assert.ok(!JSON.stringify(group).includes(cwd));
	await assert.rejects(readMcpResource(task.uri, path.join(cwd, "other")), /Unknown observation resource/);
	await assert.rejects(readMcpResource(`${task.uri}/groups/999`, cwd), /unavailable/);
	await assert.rejects(readMcpResource(`${task.uri}/groups/-1`, cwd), /invalid resource/);
	await assert.rejects(readMcpResource(`${task.uri}/scope/1`, cwd), /unavailable/);
	const scope = resourceText(await readMcpResource(index.scopeUri, cwd));
	assert.equal(scope.task.matchScope.candidateCount, 1);
	await writeFile(task.path, "{}", "utf8");
	await assert.rejects(readMcpResource(task.uri, cwd), /digest mismatch/);
});

test("task resource rejects tampered schema, mismatched snapshot, expired handles and escaping paths", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-task-resource-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const result = await pageObservationResult({
		observation: taskObservation([taskInvoice().record]),
		fallbackName: "canonical.json",
		ctx: { cwd },
		view: prepareTaskView({ focus: { query: "INV-2048" } }),
	});
	const base = (result.details![OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[]).find(
		(item) => item.taskProjection,
	)!;
	const original = await readFile(base.path, "utf8");
	const register = (descriptor: ObservationResourceDescriptor) =>
		registerMcpObservationResources({ [OBSERVATION_RESOURCES_DETAIL_KEY]: [descriptor] }, cwd);
	assert.equal(register({ ...base, expiresAt: Date.now() - 1 }).length, 0);
	assert.equal(register({ ...base, path: path.join(cwd, "outside.json") }).length, 0);
	for (const mutation of [{ schema: "wrong" }, { snapshotId: "different" }]) {
		const modified = JSON.stringify({ ...JSON.parse(original), ...mutation });
		await writeFile(base.path, modified);
		const descriptor = {
			...base,
			uri: `browser-pilot://observation/${randomUUID()}`,
			taskProjection: { sha256: taskArtifactHash(modified) },
		};
		assert.equal(register(descriptor).length, 1);
		await assert.rejects(readMcpResource(descriptor.uri, cwd), /Invalid task projection|snapshot mismatch/);
	}
	await writeFile(base.path, original);
	const outside = path.join(cwd, "outside.json");
	await writeFile(outside, original);
	const linked = path.join(path.dirname(base.path), "escape.json");
	try {
		await symlink(outside, linked, "file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			t.diagnostic("File symlinks unavailable; lexical path check covered above");
			return;
		}
		throw error;
	}
	const descriptor = { ...base, path: linked, uri: `browser-pilot://observation/${randomUUID()}` };
	assert.equal(register(descriptor).length, 1);
	await assert.rejects(readMcpResource(descriptor.uri, cwd), /outside the project artifact root/);
});

test("tight budgets fold whole groups, preserve ambiguity and never expose orphan actions", () => {
	const first = taskInvoice();
	first.note.value = "x".repeat(7000);
	const observation = taskObservation([first.record, taskInvoice("INV-2099").record]);
	const plan = projectTaskView(observation, prepareTaskView({ focus: { query: "Save" } })!);
	const view = packTaskView(observation, plan, "browser-pilot://observation/example", { items: [] }, 2500);
	assert.equal(view.task!.status, "ambiguous");
	assert.equal(view.task!.matchScope.candidateCount, 2);
	assert.ok(view.task!.outputScope.groupsFolded > 0);
	assert.equal(view.actionSpace, undefined);
	assert.ok(view.bundles!.every((bundle) => bundle.facts.some((fact) => fact.name === bundle.anchor.name)));
	assert.ok(Buffer.byteLength(JSON.stringify(view), "utf8") <= 2500);
	assert.equal(isPageObservationView(view), true);
});

test("oversized global blockers remain explicit and do not leave actionable candidate fragments", () => {
	const dialog = taskEntity("dialog", "dialog", "Login expired", [
		taskEntity("explanation", "paragraph", "x".repeat(7000)),
	]);
	const observation = taskObservation([taskInvoice().record, dialog]);
	const plan = projectTaskView(observation, prepareTaskView({ focus: { query: "INV-2048" } })!);
	const view = packTaskView(observation, plan, "browser-pilot://observation/example", { items: [] }, 2500);
	assert.equal(view.task!.outputScope.mandatoryGroupsFolded, 1);
	assert.equal(view.task!.outputScope.contextComplete, false);
	assert.equal(view.bundles!.length, 0);
	assert.ok(view.frontier!.items[0]!.resourceUri);
});

test("task diff and return-to-page do not inherit a previous task filter", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-task-mode-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const invoice = taskInvoice();
	const observation = taskObservation([invoice.record], {
		delta: "session",
		diff: { appeared: [], disappeared: [], changed: [] },
	});
	const result = await pageObservationResult({
		observation,
		ctx: { cwd },
		fallbackName: "task.json",
		view: prepareTaskView({ focus: { refs: [invoice.note.ref] }, fields: ["备注"] }),
	});
	const view = JSON.parse(result.content[0]!.text) as PageObservationView;
	assert.ok(view.bundles!.some((bundle) => bundle.facts.some((fact) => fact.value === "已联系客户")));
	const page = await pageObservationResult({ observation, ctx: { cwd }, fallbackName: "page.json" });
	assert.equal(JSON.parse(page.content[0]!.text).task, undefined);
	assert.equal(JSON.parse(page.content[0]!.text).bundles, undefined);
});

test("container group resources retain descendants and advertise full expansion bytes", async (t) => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-task-audit-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const facts = Array.from({ length: 20 }, (_, i) =>
		taskEntity(`large-${i}`, "cell", `INV-${i} ${"正文".repeat(3000)}`),
	);
	const container = taskEntity("table", "table", "Records", [taskEntity("row", "row", "Row", facts)]);
	const form = taskEntity("form", "form", "Editor", [container]);
	const result = await pageObservationResult({
		observation: taskObservation([form]),
		fallbackName: "canonical.json",
		ctx: { cwd },
		view: prepareTaskView({ focus: { refs: [container.ref] } }),
	});
	registerMcpObservationResources(result.details, cwd);
	const descriptor = (result.details![OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[]).find(
		(item) => item.taskProjection,
	)!;
	const index = resourceText(await readMcpResource(descriptor.uri, cwd));
	const groupResponse = await readMcpResource(index.groups[0].resourceUri, cwd);
	const group = resourceText(groupResponse);
	for (const fact of facts) assert.ok(group.bundle.facts.some((item: { ref: string }) => item.ref === fact.ref));
	const content = groupResponse.contents[0]!;
	assert.ok("text" in content);
	assert.equal(index.groups[0].resourceJsonBytes, Buffer.byteLength(content.text));
	assert.ok(index.groups[0].exceedsInlineBudget);
	t.diagnostic(
		JSON.stringify({
			indexBytes: Buffer.byteLength(JSON.stringify(index)),
			groupBytes: Buffer.byteLength(content.text),
			resourceResponseBytes: Buffer.byteLength(JSON.stringify(groupResponse)),
		}),
	);
	assert.ok(Buffer.byteLength(result.content[0]!.text) < 32768);
});
