import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { taskArtifactHash } from "../../src/commands/observe/taskViewProjection.ts";
import { readTaskProjectionResource } from "../../src/apps/mcp/taskViewResources.ts";
import { registerMcpObservationResources, readMcpResource } from "../../src/apps/mcp/server.ts";
import {
	OBSERVATION_RESOURCES_DETAIL_KEY,
	type ObservationResourceDescriptor,
} from "../../src/commands/observe/observationResources.ts";
import { prepareTaskView, prepareTaskViewTarget } from "../../src/commands/observe/taskViewInput.ts";
import { registerRefDescriptor } from "../../src/resources/resourceRefs.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";

const fixtures = new URL("../fixtures/task-history/", import.meta.url);
const commits = [
	"9bc01936f12c3ed84513610e24a3f452593d7c27",
	"645570730a974f44be9d3bd0fc60b05c949c7194",
	"f0a7afea5148ad327a5000c878f2aa6862493cf2",
	"75c2aafd5387cbf6e4186416783d65aeba3c7f05",
];

function descriptor(artifact: any, text: string, index: number, savedPath = "unused"): ObservationResourceDescriptor {
	return {
		uri: `browser-pilot://observation/00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		name: "Historical synthetic evidence",
		mimeType: "application/json",
		path: savedPath,
		kind: "details",
		ref: "frontier:task-view",
		snapshotId: artifact.snapshotId,
		expiresAt: artifact.expiresAt,
		taskProjection: { sha256: taskArtifactHash(text) },
	};
}

for (let version = 1; version <= 4; version++) {
	test(`real v${version} producer artifacts preserve their saved evidence and reject mismatched policies`, async () => {
		const provenance = JSON.parse(await readFile(new URL(`provenance-v${version}.json`, fixtures), "utf8"));
		assert.equal(provenance.length, 2);
		for (const entry of provenance) {
			const text = await readFile(new URL(entry.filename, fixtures), "utf8");
			assert.equal(taskArtifactHash(text), entry.artifactSha256);
			assert.equal(entry.producerCommit, commits[version - 1]);
			assert.match(entry.producerModuleSha256, /^[a-f0-9]{64}$/);
			assert.equal(taskArtifactHash(JSON.stringify(entry.input, null, 2)), entry.canonicalSha256);
			const artifact = JSON.parse(text);
			assert.equal(artifact.schema, `browser-task-projection/v${version}`);
			assert.equal(artifact.policy, `literal-context-v${version}`);
			assert.equal(artifact.canonicalSha256, entry.canonicalSha256);
			assert.deepEqual(artifact.spec, entry.spec);
			const desc = descriptor(artifact, text, version);
			const read = (suffix: string) => readTaskProjectionResource(text, desc, desc.uri + suffix) as any;
			const index = read("");
			for (let i = 0; i < artifact.bundles.length; i++) {
				const group = read(`/groups/${i}`);
				assert.deepEqual(group.bundle, artifact.bundles[i], "new evaluation must not rewrite old evidence");
				if (version === 1) assert.equal(group.bundle.requirements, undefined);
				else
					for (const kind of ["local", "owner", "identity", "actions"])
						assert.equal(
							index.groups[i].requirements[kind].evidence,
							group.bundle.requirements[kind].evidence,
						);
			}
			if (version < 3) {
				assert.equal(index.packetIndex, undefined);
				assert.throws(() => read("/packets/0"), /unavailable/);
			} else {
				assert.ok(artifact.packets.length);
				for (let i = 0; i < artifact.packets.length; i++)
					assert.deepEqual(read(`/packets/${i}`).packet, artifact.packets[i]);
			}
			for (const policy of [
				"literal-context-v0",
				...[1, 2, 3, 4].filter((v) => v !== version).map((v) => `literal-context-v${v}`),
			]) {
				const invalid = JSON.stringify({ ...artifact, policy });
				assert.throws(
					() => readTaskProjectionResource(invalid, descriptor(artifact, invalid, version), desc.uri),
					/Invalid task projection/,
				);
			}
			entry.input.entities[0].name = "A later live page";
			assert.deepEqual(read(""), index);
			assert.equal(
				taskArtifactHash(await readFile(new URL(entry.filename, fixtures), "utf8")),
				entry.artifactSha256,
			);
		}
	});
}

test("a readable historical resource does not make its expired ref executable or refresh its lifetime", async (t) => {
	let now = 2000;
	t.mock.method(Date, "now", () => now);
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-task-history-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const savedPath = path.join(cwd, ".browser-pilot", "artifacts", "historical.json");
	await mkdir(path.dirname(savedPath), { recursive: true });
	await copyFile(new URL("v4-owned.json", fixtures), savedPath);
	const text = await readFile(savedPath, "utf8");
	const artifact = JSON.parse(text);
	const desc = descriptor(artifact, text, 99, savedPath);
	assert.equal(registerMcpObservationResources({ [OBSERVATION_RESOURCES_DETAIL_KEY]: [desc] }, cwd).length, 1);
	const note = artifact.packets[0].facts.find((fact: any) => fact.role === "textbox");
	const ref = registerRefDescriptor({
		descriptor: {
			refId: note.ref,
			kind: "control",
			locators: [{ by: "css", value: "#historical-note" }],
			owner: { browserSessionId: "session-1", tabId: 7 },
			policy: { shareableAcrossSessions: false, liveActionsAllowed: true },
			observationId: artifact.snapshotId,
			createdAt: 1000,
			ttlMs: 1,
			documentEpoch: {
				targetGeneration: 1,
				pageEpoch: "page-1",
				url: "https://example.test/invoices",
				capturedAt: 1000,
			},
		},
	});
	assert.equal(ref, note.ref);
	const first = await readMcpResource(`${desc.uri}/packets/0`, cwd);
	const runtime = {
		snapshot: () => ({
			browserSessionId: "session-1",
			tabs: [{ tabId: 7, targetGeneration: 1, pageEpoch: "page-2" }],
		}),
	} as unknown as BrowserCommandRuntimePort;
	assert.throws(
		() => prepareTaskViewTarget(runtime, { view: prepareTaskView({ focus: { refs: [ref] } }) }),
		/expired|stale|unavailable|current/i,
	);
	assert.deepEqual(await readMcpResource(`${desc.uri}/packets/0`, cwd), first);
	now = artifact.expiresAt + 1;
	await assert.rejects(readMcpResource(`${desc.uri}/packets/0`, cwd), /expired|Unknown observation resource/);
	assert.equal(await readFile(savedPath, "utf8"), text);
});
