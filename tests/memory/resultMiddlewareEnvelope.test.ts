import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { distilledJsonResult } from "../../src/commands/resultMiddleware.ts";

type Envelope = Record<string, unknown>;

async function testArtifactPath(name: string): Promise<string> {
	return path.join(await mkdtemp(path.join(tmpdir(), "browser-pilot-result-envelope-")), name);
}

async function renderEnvelope(value: unknown, options: Partial<Parameters<typeof distilledJsonResult>[1]> = {}): Promise<Envelope> {
	const result = await distilledJsonResult(value, {
		commandName: "browser_command",
		command: "network.get",
		detailLevel: "summary",
		maxChars: 4_000,
		fallbackName: "result.json",
		...options,
	});
	return JSON.parse(result.content[0]?.text || "{}") as Envelope;
}

test("result middleware characterization: redaction keeps model-facing pointers and privacy metadata", async () => {
	const outputPath = await testArtifactPath("redacted-result.json");
	const value = {
		ok: true,
		requestId: "req-1",
		headers: { Authorization: "Bearer secret-token" },
		postData: "password=hunter2",
	};
	const envelope = await renderEnvelope(value, {
		artifactValue: value,
		outputPath,
		distill: () => ({ ok: true, requestId: "req-1", headers: value.headers, postData: value.postData }),
	});
	const summary = envelope.summary as Record<string, unknown>;
	const headers = summary.headers as Record<string, unknown>;
	const authorization = headers.Authorization as Record<string, unknown>;
	const postData = summary.postData as Record<string, unknown>;
	assert.equal(envelope.privacy && typeof envelope.privacy === "object" ? (envelope.privacy as Record<string, unknown>).sensitiveEvidence : undefined, true);
	assert.equal(envelope.saved && typeof envelope.saved === "object" ? (envelope.saved as Record<string, unknown>).path : undefined, path.resolve(outputPath));
	assert.equal(authorization.redacted, true);
	assert.equal(authorization.kind, "authorization");
	assert.equal(authorization.raw, path.resolve(outputPath));
	assert.equal(authorization.jsonPath, "headers.Authorization");
	assert.equal(postData.redacted, true);
	assert.equal(postData.kind, "postData");
	assert.equal(postData.jsonPath, "postData");
	assert.deepEqual((envelope.evidence as Record<string, unknown>).redaction, { applied: true });
});

test("result middleware characterization: summary fitting strips inline nextActions and emits recovery actions", async () => {
	const longText = "x".repeat(6_000);
	const envelope = await renderEnvelope({ ok: true }, {
		maxChars: 1_200,
		distill: () => ({
			ok: true,
			data: longText,
			nextActions: ["click(bp-ref://element/button/submit)", "read_saved_artifact path=/tmp/legacy"],
			focus: { primary_entities: [{ ref: "bp-ref://element/button/submit", kind: "control", role: "button" }] },
		}),
	});
	const summary = envelope.summary as Record<string, unknown>;
	assert.equal(Object.hasOwn(summary, "nextActions"), false);
	assert.ok(Array.isArray(summary.summaryOmitted));
	assert.ok(Array.isArray(envelope.nextActions));
	assert.deepEqual(envelope.nextActions, [
		"click(bp-ref://element/button/submit)",
		"read(bp-ref://element/button/submit)",
	]);
	assert.ok((envelope.nextActions as string[]).includes("pass explicit targetRef/browserSessionId for follow-up tab-scoped calls") === false);
});

test("result middleware characterization: saved artifacts drive nextActions and evidence refs", async () => {
	const outputPath = await testArtifactPath("large-result.json");
	const largePayload = { items: Array.from({ length: 60 }, (_, index) => ({ ref: `bp-ref://network-entry/${index}`, text: "payload".repeat(20) })) };
	const envelope = await renderEnvelope(largePayload, {
		maxChars: 4_000,
		artifactThreshold: 100,
		outputPath,
		operation: { operationId: "op-1", snapshotId: "snap-op" },
		snapshot: { snapshotId: "snap-1" },
		distill: () => ({
			ok: true,
			requestId: "req-1",
			nextOffset: 200,
			artifact_hints: { preferredReads: [{ label: "items", jsonPath: "items[0]" }] },
			focus: { primary_entities: [{ ref: "bp-ref://network-entry/1", kind: "element" }] },
		}),
	});
	assert.equal(envelope.saved && typeof envelope.saved === "object" ? (envelope.saved as Record<string, unknown>).path : undefined, path.resolve(outputPath));
	assert.deepEqual((envelope.nextActions as string[]).slice(0, 6), [
		"read_saved_artifact mode=json jsonPath=items[0]",
		"read_saved_artifact mode=json jsonPath=operation.operationId",
		"read_saved_artifact mode=json jsonPath=snapshot.snapshotId",
		"read_saved_artifact mode=json jsonPath=data.requestId",
		"read(bp-ref://network-entry/1)",
		"click(bp-ref://network-entry/1)",
	]);
	assert.ok((envelope.nextActions as string[]).includes("read_saved_artifact offset=200"));
	const evidence = envelope.evidence as Record<string, unknown>;
	const artifacts = evidence.artifacts as Array<Record<string, unknown>>;
	assert.equal(artifacts[0]?.path, path.resolve(outputPath));
	assert.ok(Array.isArray(evidence.runtimeRefs));
	assert.ok((evidence.runtimeRefs as string[]).includes("bp-ref://network-entry/1"));
});

test("result middleware characterization: memory fitting preserves live planes when memory fits", async () => {
	const envelope = await renderEnvelope({ ok: true }, {
		commandName: "browser_observe",
		command: "scan",
		maxChars: 4_000,
		memoryAugmentationPlan: {
			inline: { facts: [{ id: "fact-1", text: "Remembered checkout affordance" }] },
			handleOnly: { handle: "browser-memory://session/facts" },
		},
		distill: () => ({
			ok: true,
			focus: {
				gist: { title: "Checkout" },
				primary_entities: [{ ref: "bp-ref://element/button/pay", kind: "control" }],
			},
		}),
	});
	assert.deepEqual(envelope.memory, { facts: [{ id: "fact-1", text: "Remembered checkout affordance" }] });
	assert.deepEqual(envelope.gist, { title: "Checkout" });
	assert.deepEqual(envelope.entities, [{ ref: "bp-ref://element/button/pay", kind: "control" }]);
});
