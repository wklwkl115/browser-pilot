import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { distilledJsonResult, distilledTextResult } from "../../src/commands/resultMiddleware.ts";

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

async function renderTextEnvelope(value: string, options: Partial<Parameters<typeof distilledTextResult>[1]> = {}): Promise<Envelope> {
	const result = await distilledTextResult(value, {
		commandName: "browser_observe",
		command: "html",
		detailLevel: "summary",
		maxChars: 4_000,
		fallbackName: "page.html",
		...options,
	});
	return JSON.parse(result.content[0]?.text || "{}") as Envelope;
}

function largeCanonicalObservationSummary(): Record<string, unknown> {
	return {
		ok: true,
		model: "PageObservation",
		canonical: true,
		pageObservation: {
			model: "PageObservation",
			canonical: true,
			entities: Array.from({ length: 120 }, (_, index) => ({ ref: `bp-ref://element/${index}`, name: "Checkout field ".repeat(20), role: "textbox" })),
			content: { text: "visible page copy ".repeat(500) },
		},
		focus: {
			gist: { title: "Checkout", description: "checkout page ".repeat(200) },
			primary_entities: Array.from({ length: 80 }, (_, index) => ({ ref: `bp-ref://element/${index}`, kind: "control", role: "button", name: "Pay now ".repeat(20) })),
		},
	};
}

function artifactHintFields(envelope: Envelope) {
	const hints = envelope.artifact_hints as Record<string, unknown>;
	return {
		hints,
		paths: hints.jsonPaths as Record<string, unknown>,
		reads: hints.preferredReads as Array<Record<string, unknown>>,
	};
}

function assertPathHint(hints: ReturnType<typeof artifactHintFields>, label: string, jsonPath: string, kind: string) {
	assert.equal(hints.paths[label], jsonPath);
	assert.ok(hints.reads.some((read) => read.label === label && read.jsonPath === jsonPath && read.kind === kind));
}

test("result middleware characterization: default observe budget preserves final no-mode canonical marker", async () => {
	const envelope = await renderEnvelope({ ok: true }, {
		commandName: "browser_observe",
		command: "scan",
		maxChars: 35_000,
		distill: largeCanonicalObservationSummary,
	});
	const summary = envelope.summary as Record<string, unknown>;
	const pageObservation = summary.pageObservation as Record<string, unknown>;
	assert.equal(summary.model, "PageObservation");
	assert.equal(summary.canonical, true);
	assert.equal(pageObservation.model, "PageObservation");
	assert.equal(pageObservation.canonical, true);
});

test("result middleware characterization: low observe budget preserves final no-mode canonical marker", async () => {
	const envelope = await renderEnvelope({ ok: true }, {
		commandName: "browser_observe",
		command: "scan",
		maxChars: 1_000,
		distill: largeCanonicalObservationSummary,
	});
	const summary = envelope.summary as Record<string, unknown>;
	assert.deepEqual(summary.pageObservation, { model: "PageObservation", canonical: true });
});

test("result middleware characterization: text summary precedence stays explicit, custom, then HTML fallback", async () => {
	let distillCalls = 0;
	const explicit = await renderTextEnvelope("<title>ignored</title>", {
		summary: { source: "explicit" },
		distill: () => { distillCalls += 1; return { source: "custom" }; },
	});
	assert.equal((explicit.summary as Record<string, unknown>).source, "explicit");
	assert.equal(distillCalls, 0);

	const custom = await renderTextEnvelope("<title>ignored</title>", {
		distill: () => { distillCalls += 1; return { source: "custom" }; },
	});
	assert.equal((custom.summary as Record<string, unknown>).source, "custom");
	assert.equal(distillCalls, 1);

	const fallback = await renderTextEnvelope("<html><head><title>Fallback</title></head><body><a>Link</a></body></html>");
	const fallbackSummary = fallback.summary as Record<string, unknown>;
	assert.deepEqual(fallbackSummary.titles, ["Fallback"]);
	assert.equal((fallbackSummary.counts as Record<string, unknown>).links, 1);
});

test("result middleware characterization: structural envelope planes and correlation stay aligned", async () => {
	const envelope = await renderEnvelope({ ok: true }, {
		commandName: "browser_observe",
		command: "scan",
		browserSessionId: "browser-session-1",
		maxChars: 35_000,
		entities: [{ ref: "bp-ref://element/explicit", kind: "control" }],
		error: { error_code: "EXPLICIT_ERROR", message: "explicit" },
		operation: { operationId: "operation-1", snapshotId: "operation-snapshot", sourceMode: "execute" },
		snapshot: { snapshotId: "snapshot-1", sourceMode: "observe" },
		activeContext: { tabId: 7, targetRef: "tab-7" },
		diagnostics: { phase: "projection" },
		distill: () => ({
			ok: true,
			requestId: "request-1",
			waitId: "wait-1",
			listenerId: "listener-1",
			sessionId: "session-1",
			selectionVersionAtDispatch: 2,
			selectionVersionAtResolve: 3,
			sourceMode: "scan",
			abmlIntegrated: false,
			delta: "session",
			baselineSnapshotId: "baseline-1",
			focus: {
				gist: { title: "Checkout" },
				outline: [{ ref: "bp-ref://region/main", name: "Main" }],
				relations: { summary: { controls: 1 } },
				diff: { summary: { changed: 1 } },
				treeDiff: { summary: { appeared: 1 } },
				snapshotProjection: { summary: { templateCount: 1 } },
				collections: [{ ref: "bp-ref://collection/items", count: 2 }],
			},
			identity: { stable: true },
			causal: { requests: [{ requestId: "request-1" }] },
		}),
	});
	assert.equal(envelope.renderer, "salience-v1");
	assert.equal(envelope.delta, "session");
	assert.equal(envelope.baselineSnapshotId, "baseline-1");
	assert.equal(envelope.abmlIntegrated, false);
	assert.deepEqual(envelope.gist, { title: "Checkout" });
	assert.deepEqual(envelope.outline, [{ ref: "bp-ref://region/main", name: "Main" }]);
	assert.deepEqual(envelope.relations, { summary: { controls: 1 } });
	assert.deepEqual(envelope.identity, { stable: true });
	assert.deepEqual(envelope.diff, { summary: { changed: 1 } });
	assert.deepEqual(envelope.causal, { requests: [{ requestId: "request-1" }] });
	assert.deepEqual(envelope.treeDiff, { summary: { appeared: 1 } });
	assert.deepEqual(envelope.snapshotProjection, { summary: { templateCount: 1 } });
	assert.deepEqual(envelope.collections, [{ ref: "bp-ref://collection/items", count: 2 }]);
	assert.deepEqual(envelope.error, { error_code: "EXPLICIT_ERROR", message: "explicit" });
	assert.deepEqual(envelope.activeContext, { tabId: 7, targetRef: "tab-7" });
	assert.deepEqual(envelope.correlation, { requestId: "request-1", waitId: "wait-1", listenerId: "listener-1", sessionId: "session-1", selectionVersionAtDispatch: 2, selectionVersionAtResolve: 3, sourceMode: "observe", operationId: "operation-1", snapshotId: "snapshot-1" });
	assert.ok((envelope.entities as Array<Record<string, unknown>>).some((entity) => entity.ref === "bp-ref://element/explicit"));
});

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

test("result middleware characterization: saved artifacts include the final rendered envelope", async () => {
	const outputPath = await testArtifactPath("observe-result.json");
	const rawValue = { data: { content: "hello" }, pageObservation: { model: "PageObservation", canonical: true } };
	const envelope = await renderEnvelope(rawValue, {
		commandName: "browser_observe",
		command: "scan",
		outputPath,
		artifactThreshold: 1,
		distill: () => ({ ok: true, pageObservation: rawValue.pageObservation }),
	});
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
	assert.deepEqual(artifact.data, rawValue.data);
	assert.deepEqual(artifact.envelope, envelope);
	assert.equal((artifact.envelope as Record<string, unknown>).tool, "browser_observe");
	assert.deepEqual(((artifact.envelope as Record<string, unknown>).summary as Record<string, unknown>).pageObservation, rawValue.pageObservation);
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
		maxChars: 8_000,
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

test("result middleware emits compact artifact schema and path hints without nonexistent paths", async () => {
	const outputPath = await testArtifactPath("hinted-result.json");
	const rawValue = { data: { content: "hello", actionables: [{ ref: "bp-ref://element/1" }] }, items: [{ id: 1 }] };
	const envelope = await renderEnvelope(rawValue, {
		outputPath,
		artifactThreshold: 1,
		distill: () => ({ ok: true, artifact_hints: { jsonPaths: { content: "data.content", missing: "data.nope" }, preferredReads: [{ label: "content", jsonPath: "data.content", kind: "text" }, { label: "missing", jsonPath: "data.nope", kind: "missing" }] } }),
	});
	const hints = artifactHintFields(envelope);
	assert.equal(hints.hints.kind, "BrowserCommandResult");
	assert.equal(hints.hints.schemaVersion, 1);
	assertPathHint(hints, "data", "data", "primary-data");
	assertPathHint(hints, "items", "items", "primary-items");
	assertPathHint(hints, "content text", "data.content", "text");
	assert.equal(hints.paths.content, "data.content");
	assert.equal(hints.paths.missing, undefined);
	assert.equal(hints.reads.some((read) => read.jsonPath === "data.nope"), false);
	assert.equal((hints.hints.saved as Record<string, unknown>).path, path.resolve(outputPath));
	assert.equal(JSON.stringify(hints.hints).includes("hello"), false);
});

test("result middleware emits observe artifact hints while preserving existing jsonPath compatibility", async () => {
	const outputPath = await testArtifactPath("observe-hints.json");
	const rawValue = {
		data: { content: "visible text", actionables: [{ ref: "bp-ref://element/submit" }], list_hints: [{ ref: "bp-ref://list/cart" }], rows: [{ id: "row-1" }], media_candidates: [{ src: "hero.png" }] },
		pageObservation: { content: { artifact: { path: outputPath, jsonPath: "pageObservation.content" } } },
		envelope: { summary: { pageObservation: { content: { artifact: { path: outputPath, jsonPath: "summary.pageObservation.content" } } } } },
	};
	const envelope = await renderEnvelope(rawValue, {
		commandName: "browser_observe",
		command: "scan",
		maxChars: 12_000,
		outputPath,
		artifactThreshold: 1,
		distill: () => ({ ok: true, artifact_hints: { jsonPaths: { legacyContent: "pageObservation.content", missingLegacy: "pageObservation.missing" }, preferredReads: [{ label: "legacy content", jsonPath: "pageObservation.content", kind: "compat-jsonPath" }, { label: "missing", jsonPath: "pageObservation.missing", kind: "missing" }] } }),
	});
	const hints = artifactHintFields(envelope);
	assert.equal(hints.hints.kind, "PageObservation");
	assertPathHint(hints, "data", "data", "primary-data");
	assertPathHint(hints, "content text", "data.content", "text");
	assertPathHint(hints, "actionables", "data.actionables", "primary-items");
	assertPathHint(hints, "list hints", "data.list_hints", "primary-items");
	assertPathHint(hints, "rows", "data.rows", "primary-items");
	assertPathHint(hints, "media candidates", "data.media_candidates", "primary-items");
	assert.equal(hints.paths.legacyContent, "pageObservation.content");
	assert.ok(hints.reads.some((read) => read.jsonPath === "pageObservation.content"));
	assert.equal(hints.paths.missingLegacy, undefined);
	assert.equal(hints.reads.some((read) => read.jsonPath === "pageObservation.missing"), false);
	assert.equal(JSON.stringify(hints.hints).includes("visible text"), false);
});

test("result middleware emits crawl artifact hints for summary items and body without copying payload", async () => {
	const outputPath = await testArtifactPath("crawl-hints.json");
	const rawValue = {
		summary: { discovered: 2, seed: "https://example.test" },
		pages: [{ url: "https://example.test" }, { url: "https://example.test/login" }],
		body: "crawl response body ".repeat(100),
		text: "crawl visible text ".repeat(100),
		providerArtifacts: { har: outputPath },
	};
	const envelope = await renderEnvelope(rawValue, {
		commandName: "browser_crawl",
		command: "crawl",
		outputPath,
		artifactThreshold: 1,
		distill: () => ({ ok: true, artifact_hints: { jsonPaths: { providerArtifacts: "providerArtifacts", missingProvider: "providerArtifacts.nope" }, preferredReads: [{ label: "provider artifacts", jsonPath: "providerArtifacts", kind: "provider-artifacts" }, { label: "missing provider", jsonPath: "providerArtifacts.nope", kind: "provider-artifacts" }] } }),
	});
	const hints = artifactHintFields(envelope);
	assert.equal(hints.hints.kind, "CrawlResult");
	assertPathHint(hints, "summary", "summary", "summary");
	assertPathHint(hints, "pages", "pages", "primary-items");
	assertPathHint(hints, "body", "body", "body");
	assertPathHint(hints, "text", "text", "text");
	assert.equal(hints.paths.providerArtifacts, "providerArtifacts");
	assert.equal(hints.paths.missingProvider, undefined);
	assert.equal(hints.reads.some((read) => read.jsonPath === "providerArtifacts.nope"), false);
	assert.equal(JSON.stringify(hints.hints).includes("crawl response body"), false);
});

test("result middleware emits execute artifact hints for result program frames and monitor data", async () => {
	const outputPath = await testArtifactPath("execute-hints.json");
	const rawValue = {
		executed: [{ frameId: 0, ok: true }],
		result: { value: "execution result", nested: { count: 1 } },
		monitor: { events: [{ type: "console", text: "hello" }] },
		data: { records: [1, 2, 3] },
		largePayload: "execute payload ".repeat(100),
	};
	const envelope = await renderEnvelope(rawValue, {
		commandName: "browser_execute",
		command: "program",
		outputPath,
		artifactThreshold: 1,
		distill: () => ({ ok: true, artifact_hints: { jsonPaths: { nestedResult: "result.nested", missingResult: "result.missing" }, preferredReads: [{ label: "nested result", jsonPath: "result.nested", kind: "execute-result" }, { label: "missing result", jsonPath: "result.missing", kind: "execute-result" }] } }),
	});
	const hints = artifactHintFields(envelope);
	assert.equal(hints.hints.kind, "ExecuteProgramResult");
	assertPathHint(hints, "data", "data", "primary-data");
	assertPathHint(hints, "executed", "executed", "program-frames");
	assertPathHint(hints, "result", "result", "execute-result");
	assertPathHint(hints, "monitor", "monitor", "execute-monitor");
	assert.equal(hints.paths.nestedResult, "result.nested");
	assert.equal(hints.paths.missingResult, undefined);
	assert.equal(hints.reads.some((read) => read.jsonPath === "result.missing"), false);
	assert.equal(JSON.stringify(hints.hints).includes("execute payload"), false);
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
