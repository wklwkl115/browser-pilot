import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMemoryAugmentationPlan } from "../../src/commands/observe/memoryAugmentation.ts";
import { readBrowserMemory, readBrowserMemoryResource } from "../../src/commands/memory/reader.ts";
import { recallMemory, recordMemoryEntry, validateMemoryRecord } from "../../src/commands/memory/store.ts";
import { validateMemoryRecordPayloadShape } from "../../src/commands/memory/evidence.ts";
import { consumeMemoryProfileDiagnostics, drainMemoryProfileFlushes, recordMemoryProfileFrame, readCachedMemoryProfile, recordMemoryProfileStrike } from "../../src/memory/profileService.ts";
import { parseMemoryEntry, serializeMemoryEntry } from "../../src/memory/frontmatter.ts";
import { readMemoryIndex, writeDerivedMemoryIndex } from "../../src/memory/indexStore.ts";
import { hmacMemoryStamp } from "../../src/memory/hashStamp.ts";
import { memoryEntryDir, resolveMemoryPath } from "../../src/memory/paths.ts";
import { memoryProfileFilePath, readMemoryProfile, writeMemoryProfile } from "../../src/memory/profileStore.ts";
import { memorySecretPath, readMemorySecret, readOrCreateMemorySecret } from "../../src/memory/secret.ts";
import { resolveBrowserResultEvidence } from "../../src/resources/browserResultEvidence.ts";
import { clearResourceStore, registerBrowserResultResource, resolveRefUriDetailed, resolveResourceUri } from "../../src/resources/resourceRefs.ts";
import type { MemoryEntry, MemoryRecordPayload } from "../../src/memory/types.ts";

function makeMemoryRoot() {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-memory-"));
	mkdirSync(resolveMemoryPath(cwd, memoryEntryDir()), { recursive: true });
	return cwd;
}

function basePayload(overrides: Partial<MemoryRecordPayload> = {}): MemoryRecordPayload {
	return {
		kind: "fact",
		url: "https://example.test/account",
		title: "Account portal region",
		triggers: ["account portal"],
		body: "The account portal is available at /account.",
		evidenceRefs: [],
		...overrides,
	};
}

function writeEntry(cwd: string, entry: Omit<MemoryEntry, "relPath" | "etag">) {
	writeFileSync(resolveMemoryPath(cwd, memoryEntryDir(), `${entry.id}.md`), serializeMemoryEntry(entry), "utf8");
}

async function readEntry(cwd: string, id: string): Promise<MemoryEntry> {
	const relPath = `${memoryEntryDir()}/${id}.md`;
	return parseMemoryEntry(await readFile(resolveMemoryPath(cwd, relPath), "utf8"), relPath);
}

test("memory record validation accepts fact-only payloads", () => {
	const result = validateMemoryRecordPayloadShape(basePayload());
	assert.equal(result.scopeKind, "origin");
	assert.equal(result.scopeKey, "example.test");
	assert.equal(result.confidence, "verified");
});

test("memory record validation rejects non-fact kinds", () => {
	assert.throws(
		() => validateMemoryRecordPayloadShape(basePayload({ kind: "workflow" as "fact" })),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_SCHEMA_INVALID" && /kind=fact/.test((error as Error).message),
	);
});

test("memory record validation rejects SOP and workflow content", () => {
	for (const payload of [
		basePayload({ title: "Checkout SOP" }),
		basePayload({ triggers: ["checkout workflow"] }),
		basePayload({ body: "Steps: click checkout, enter details, submit." }),
	]) {
		assert.throws(
			() => validateMemoryRecordPayloadShape(payload),
			(error: unknown) => (error as { code?: string }).code === "MEMORY_SCHEMA_INVALID" && /durable facts only/.test((error as Error).message),
		);
	}
});

test("memory record writes fact entries and recall/read preserve URI behavior", async () => {
	const cwd = makeMemoryRoot();
	const recorded = await recordMemoryEntry({ cwd, payload: basePayload() });
	assert.equal(recorded.entry.kind, "fact");
	assert.equal(recorded.index.entries.length, 1);
	assert.match(recorded.entry.relPath, /^facts[\\/]/);
	const readBack = await readEntry(cwd, recorded.entry.id);
	assert.equal(readBack.body.trim(), basePayload().body);
	const recall = await recallMemory({ cwd, url: "https://example.test/account/profile", query: "account portal" });
	assert.equal(recall.totalMatches, 1);
	assert.equal(recall.cards[0]?.id, recorded.entry.id);
	assert.match(recall.cards[0]?.handles[0] ?? "", /^browser-memory:\/\/fact\//);
	assert.match(recall.cards[0]?.body ?? "", /available at \/account/);
	const readResult = await readBrowserMemory({ cwd, uri: `browser-memory://fact/${recorded.entry.id}`, mode: "json" });
	assert.equal(readResult.mode, "json");
	assert.equal(((readResult.value as { frontmatter?: { id?: string } }).frontmatter ?? {}).id, recorded.entry.id);
});

test("memory record dedups exact facts and reports merely similar candidates", async () => {
	const cwd = makeMemoryRoot();
	const first = await recordMemoryEntry({ cwd, payload: basePayload({ title: "Account portal URL", body: "The account portal lives at /account." }) });
	const similar = await validateMemoryRecord({ cwd, payload: basePayload({ title: "Account portal location", body: "The account portal lives at /account for the region." }) });
	assert.deepEqual(similar.existingIds, []);
	assert.deepEqual(similar.duplicateCandidates.map((item) => item.id), [first.entry.id]);
	const exact = await recordMemoryEntry({ cwd, payload: basePayload({ title: "Account portal URL", body: "The account portal lives at /account." }) });
	assert.deepEqual(exact.supersededIds, [first.entry.id]);
});

test("memory recall is isolated by cwd and profile files stay under each cwd", async () => {
	const firstCwd = makeMemoryRoot();
	const secondCwd = makeMemoryRoot();
	await recordMemoryEntry({ cwd: firstCwd, payload: basePayload({ title: "First cwd portal", body: "The isolated portal lives in cwd one." }) });
	const firstRecall = await recallMemory({ cwd: firstCwd, url: "https://example.test/account", query: "isolated portal" });
	const secondRecall = await recallMemory({ cwd: secondCwd, url: "https://example.test/account", query: "isolated portal" });
	assert.equal(firstRecall.totalMatches, 1);
	assert.equal(secondRecall.totalMatches, 0);
	await writeMemoryProfile(firstCwd, { schemaVersion: 1, origin: "https://example.test", sessions: [], termStats: {}, urls: [], strikes: {} });
	assert.notEqual(memoryProfileFilePath(firstCwd, "https://example.test"), memoryProfileFilePath(secondCwd, "https://example.test"));
	assert.deepEqual((await readMemoryProfile(secondCwd, "https://example.test")).profile, undefined);
});

test("memory profile reads report malformed profile metadata without crossing cwd scope", async () => {
	const cwd = makeMemoryRoot();
	const filePath = memoryProfileFilePath(cwd, "https://example.test");
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, origin: "https://other.test", sessions: [], urls: [], termStats: {}, strikes: {} }), "utf8");
	const result = await readMemoryProfile(cwd, "https://example.test");
	assert.equal(result.profile, undefined);
	assert.equal(result.warning, "memory_profile_unreadable");
});

test("memory profile service recovers from malformed disk data without dropping pending frames", async () => {
	const cwd = makeMemoryRoot();
	const filePath = memoryProfileFilePath(cwd, "https://example.test");
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, "{not-json", "utf8");
	await recordMemoryProfileFrame({
		cwd,
		browserSessionId: "session-1",
		frame: {
			key: { browserSessionId: "session-1", navigationEpoch: "nav-1" },
			snapshotId: "snapshot-1",
			capturedAt: 1000,
			facts: { "bp-ref://element/account": { versionStamp: "account-visible-v1", stableStamp: "account-visible", lastShownGranularity: "full" } },
			pageFingerprint: { changeSeq: 7, url: "https://example.test/account?token=hidden", readyState: "complete", visibleCount: 4, interactiveCount: 2 },
		},
		trace: {
			latestSeq: 3,
			terms: [
				{ term: "account-portal", kind: "selectorLiteral", at: 1000, seq: 1 },
				{ term: "password=hunter2", kind: "selectorLiteral", at: 1001, seq: 2 },
				{ term: "customer@example.test", kind: "selectorLiteral", at: 1002, seq: 3 },
			],
		},
	});
	await drainMemoryProfileFlushes();
	const profile = (await readMemoryProfile(cwd, "https://example.test")).profile;
	assert.ok(profile);
	assert.deepEqual(profile.urls.map((item) => item.canonicalUrl), ["https://example.test/account"]);
	assert.equal(profile.urls[0]?.fingerprintSummary?.readyState, "complete");
	assert.ok(Object.values(profile.urls[0]?.factStamps ?? {}).every((stamp) => !stamp.includes("account-visible")));
	assert.ok(Object.values(profile.termStats).some((term) => term.term === "account-portal"));
	assert.ok(Object.values(profile.termStats).every((term) => !/hunter2|customer@example\.test/i.test(term.term)));
	assert.deepEqual((await readCachedMemoryProfile(cwd, "https://other.test"))?.urls ?? [], []);
});

test("memory secrets stay cwd scoped and stamps do not echo raw stable values", async () => {
	const firstCwd = makeMemoryRoot();
	const secondCwd = makeMemoryRoot();
	const firstSecret = await readOrCreateMemorySecret(firstCwd);
	const secondSecret = await readOrCreateMemorySecret(secondCwd);
	assert.ok(firstSecret);
	assert.ok(secondSecret);
	assert.equal((await readMemorySecret(firstCwd))?.toString("hex"), firstSecret.toString("hex"));
	assert.notEqual(firstSecret.toString("hex"), secondSecret.toString("hex"));
	assert.notEqual(memorySecretPath(firstCwd), memorySecretPath(secondCwd));
	const stamp = await hmacMemoryStamp(firstCwd, "https://example.test", "raw-version-stamp");
	assert.match(stamp ?? "", /^[a-f0-9]{32}$/);
	assert.notEqual(stamp, "raw-version-stamp");
});

test("memory read rejects traversal-like fact URIs through normalized not-found handling", async () => {
	const cwd = makeMemoryRoot();
	const result = await readBrowserMemoryResource("browser-memory://fact/../../outside?mode=json", cwd);
	assert.equal(result.ok, false);
	assert.equal(result.code, "MEMORY_ENTRY_NOT_FOUND");
});

test("memory index derivation ignores malformed records while preserving valid facts", async () => {
	const cwd = makeMemoryRoot();
	const now = new Date().toISOString();
	writeFileSync(resolveMemoryPath(cwd, memoryEntryDir(), "broken.md"), "---\nschemaVersion: 1\nid: broken\ntitle: Broken persisted fact\nkind: workflow\ntriggers:\n  - valid persisted\nscopeKind: origin\nscopeKey: example.test\nsensitivity: local\nstatus: active\nconfidence: verified\nverifiedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\nevidenceRefs: []\n---\nMalformed legacy body.\n", "utf8");
	writeEntry(cwd, {
		schemaVersion: 1,
		id: "valid-fact",
		title: "Valid persisted fact",
		kind: "fact",
		triggers: ["valid persisted"],
		scopeKind: "origin",
		scopeKey: "example.test",
		sensitivity: "local",
		status: "active",
		confidence: "verified",
		verifiedAt: now,
		updatedAt: now,
		evidenceRefs: [],
		body: "Only the valid persisted fact is indexed.",
	});
	const index = await writeDerivedMemoryIndex(cwd);
	assert.deepEqual(index.entries.map((entry) => entry.id), ["valid-fact"]);
	const recall = await recallMemory({ cwd, url: "https://example.test/path", query: "valid persisted" });
	assert.equal(recall.totalMatches, 1);
	assert.equal(recall.cards[0]?.id, "valid-fact");
});

test("memory recall ranking prefers exact scoped facts and omits superseded duplicates", async () => {
	const cwd = makeMemoryRoot();
	const first = await recordMemoryEntry({ cwd, payload: basePayload({ title: "Portal canonical URL", body: "The portal canonical URL is /account." }) });
	const replacement = await recordMemoryEntry({ cwd, payload: basePayload({ title: "Portal canonical URL", body: "The portal canonical URL is /account." }) });
	await recordMemoryEntry({ cwd, payload: basePayload({ scopeKind: "project", scopeKey: "browser-pilot", title: "Portal project note", body: "The portal project note is less specific." }) });
	const recall = await recallMemory({ cwd, url: "https://example.test/account", query: "portal" });
	assert.equal(recall.cards[0]?.id, replacement.entry.id);
	assert.equal(recall.cards.some((card) => card.id === first.entry.id), false);
	assert.match(recall.cards[0]?.matchReason ?? "", /exact-origin/);
});

test("browser-result resources expose stable handles and stale freshness after artifact rewrites", async () => {
	clearResourceStore();
	const cwd = makeMemoryRoot();
	const artifactPath = resolveMemoryPath(cwd, "resource.json");
	writeFileSync(artifactPath, JSON.stringify({ version: 1 }), "utf8");
	const uri = registerBrowserResultResource({ kind: "evidence", artifactPath, name: "resource" });
	const resource = resolveResourceUri(uri);
	assert.ok(resource);
	assert.match(uri, /^browser-result:\/\//);
	assert.doesNotMatch(uri, /resource\.json/);
	const evidence = await resolveBrowserResultEvidence(uri);
	assert.equal(evidence.ok, true);
	assert.equal(evidence.ok ? evidence.path : undefined, path.normalize(artifactPath));
	const fresh = resolveRefUriDetailed(resource.refId);
	assert.equal(fresh.ok, true);
	assert.equal(fresh.ok ? fresh.ref.fresh : undefined, true);
	writeFileSync(artifactPath, JSON.stringify({ version: 2, changed: true }), "utf8");
	const stale = resolveRefUriDetailed(resource.refId);
	assert.equal(stale.ok, true);
	assert.equal(stale.ok ? stale.ref.fresh : undefined, false);
	const staleEvidence = await resolveBrowserResultEvidence(uri);
	assert.equal(staleEvidence.ok, false);
	assert.equal(staleEvidence.ok ? undefined : staleEvidence.code, "MEMORY_EVIDENCE_STALE");
	const invalid = resolveRefUriDetailed("browser-result://missing-resource");
	assert.equal(invalid.ok, false);
	assert.equal(invalid.ok ? undefined : invalid.code, "HANDLE_NOT_FOUND");
	const missingEvidence = await resolveBrowserResultEvidence("browser-result://missing-resource");
	assert.equal(missingEvidence.ok, false);
	assert.equal(missingEvidence.ok ? undefined : missingEvidence.code, "MEMORY_EVIDENCE_UNRESOLVABLE");
	clearResourceStore();
});

test("memory validation keeps evidence paths inside the active workspace", async () => {
	clearResourceStore();
	const firstCwd = makeMemoryRoot();
	const secondCwd = makeMemoryRoot();
	const firstArtifact = resolveMemoryPath(firstCwd, "evidence-secret.json");
	writeFileSync(firstArtifact, JSON.stringify({ ok: true }), "utf8");
	const uri = registerBrowserResultResource({ kind: "evidence", artifactPath: firstArtifact, name: "evidence" });

	const accepted = await validateMemoryRecord({ cwd: firstCwd, resolver: resolveBrowserResultEvidence, payload: basePayload({ evidenceRefs: [uri] }) });
	assert.equal(accepted.entry.evidenceRefs[0]?.kind, "browser-result");

	await assert.rejects(
		validateMemoryRecord({ cwd: secondCwd, resolver: resolveBrowserResultEvidence, payload: basePayload({ evidenceRefs: [uri] }) }),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_EVIDENCE_UNRESOLVABLE" && /outside workspace/.test((error as Error).message) && !/evidence-secret|browser-pilot-memory/i.test((error as Error).message),
	);
	await assert.rejects(
		validateMemoryRecord({ cwd: secondCwd, payload: basePayload({ evidenceRefs: [{ kind: "artifact", path: firstArtifact }] }) }),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_EVIDENCE_UNRESOLVABLE" && /outside workspace/.test((error as Error).message) && !/evidence-secret|browser-pilot-memory/i.test((error as Error).message),
	);
	await assert.rejects(
		validateMemoryRecord({ cwd: secondCwd, payload: basePayload({ evidenceRefs: [{ kind: "operation", operationId: "op-1", path: firstArtifact }] }) }),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_EVIDENCE_UNRESOLVABLE" && /outside workspace/.test((error as Error).message) && !/evidence-secret|browser-pilot-memory/i.test((error as Error).message),
	);
	clearResourceStore();
});

test("memory validation rejects missing browser-result resources through resolver boundary", async () => {
	clearResourceStore();
	const cwd = makeMemoryRoot();
	await assert.rejects(
		validateMemoryRecord({ cwd, resolver: async () => ({ ok: false, code: "HANDLE_NOT_FOUND", error: "Resource not found" }), payload: basePayload({ evidenceRefs: ["browser-result://missing-resource"] }) }),
		(error: unknown) => (error as { code?: string }).code === "HANDLE_NOT_FOUND" && /Resource not found/.test((error as Error).message),
	);
});

test("memory recall freshOnly filters entries without profile anchors", async () => {
	const cwd = makeMemoryRoot();
	await recordMemoryEntry({ cwd, payload: basePayload() });
	const normal = await recallMemory({ cwd, url: "https://example.test/account", query: "account portal" });
	assert.equal(normal.totalMatches, 1);
	const freshOnly = await recallMemory({ cwd, url: "https://example.test/account", query: "account portal", freshOnly: true });
	assert.equal(freshOnly.totalMatches, 0);
});

test("memory validation returns evidence expiry warnings for near-expiry browser-result refs", async () => {
	clearResourceStore();
	const cwd = makeMemoryRoot();
	const artifactPath = resolveMemoryPath(cwd, "evidence.json");
	writeFileSync(artifactPath, JSON.stringify({ ok: true }), "utf8");
	const uri = registerBrowserResultResource({ kind: "evidence", artifactPath, name: "evidence" });
	const resource = resolveResourceUri(uri);
	assert.ok(resource);
	resource.expiresAt = Date.now() + 60_000;
	const validated = await validateMemoryRecord({
		cwd,
		resolver: async () => ({ ok: true, path: artifactPath }),
		payload: basePayload({ evidenceRefs: [uri] }),
	});
	assert.equal(validated.evidenceExpiry.length, 1);
	assert.match(validated.warnings[0] ?? "", /expires/);
	clearResourceStore();
});

test("browser_observe memory augmentation surfaces matched facts only", async () => {
	const cwd = makeMemoryRoot();
	const now = new Date().toISOString();
	writeEntry(cwd, {
		schemaVersion: 1,
		id: "checkout-portal-fact",
		title: "Checkout portal URL",
		kind: "fact",
		triggers: ["checkout portal"],
		scopeKind: "origin",
		scopeKey: "https://example.test",
		sensitivity: "local",
		status: "active",
		confidence: "verified",
		verifiedAt: now,
		updatedAt: now,
		evidenceRefs: [],
		body: "The checkout portal is located at /checkout.",
	});
	await writeDerivedMemoryIndex(cwd);
	const plan = await buildMemoryAugmentationPlan(cwd, "https://example.test/cart", "checkout portal");
	const inline = plan?.inline as { cards?: Array<{ kind?: string; title?: string; body?: string }> } | undefined;
	const collapsed = plan?.handleOnly as { cards?: Array<{ kind?: string; body?: string }> } | undefined;
	assert.equal(inline?.cards?.length, 1);
	assert.equal(inline.cards[0]?.kind, "fact");
	assert.equal(inline.cards[0]?.title, "Checkout portal URL");
	assert.match(inline.cards[0]?.body ?? "", /\/checkout/);
	assert.equal(collapsed?.cards?.[0]?.kind, "fact");
	assert.equal(Object.hasOwn(collapsed?.cards?.[0] ?? {}, "body"), false);
});

test("browser_observe memory augmentation ignores origin-only SOP-like candidates without an idf match", async () => {
	const cwd = makeMemoryRoot();
	const now = new Date().toISOString();
	writeEntry(cwd, {
		schemaVersion: 1,
		id: "legacy-sop-like-fact",
		title: "Legacy onboarding procedure",
		kind: "fact",
		triggers: ["standard operating procedure"],
		scopeKind: "origin",
		scopeKey: "https://example.test",
		sensitivity: "local",
		status: "active",
		confidence: "verified",
		verifiedAt: now,
		updatedAt: now,
		evidenceRefs: [],
		body: "Legacy SOP content from an older local store.",
	});
	await writeDerivedMemoryIndex(cwd);
	const plan = await buildMemoryAugmentationPlan(cwd, "https://example.test/cart", "checkout portal");
	assert.equal(plan, undefined);
});

test("legacy SOP entries in index.json are sanitized from read, recall, and observe surfaces", async () => {
	const cwd = makeMemoryRoot();
	const now = new Date().toISOString();
	writeFileSync(resolveMemoryPath(cwd, "index.json"), JSON.stringify({
		schemaVersion: 1,
		generatedAt: now,
		entries: [
			{
				id: "legacy-sop-entry",
				kind: "sop",
				title: "Legacy checkout SOP",
				triggers: ["checkout portal"],
				scopeKind: "origin",
				scopeKey: "https://example.test",
				status: "active",
				confidence: "verified",
				updatedAt: now,
				handles: ["browser-memory://sop/legacy-sop-entry"],
			},
		],
		byScope: { "origin:https://example.test": ["legacy-sop-entry"] },
		routing: { checkout: ["legacy-sop-entry"], portal: ["legacy-sop-entry"] },
	}, null, 2), "utf8");

	const index = await readMemoryIndex(cwd);
	assert.deepEqual(index.entries, []);
	assert.deepEqual(index.byScope, {});
	assert.deepEqual(index.routing, {});

	const readIndex = await readBrowserMemory({ cwd, uri: "browser-memory://index", mode: "json" });
	assert.equal(readIndex.mode, "json");
	assert.deepEqual((readIndex.value as { entries?: unknown[] }).entries, []);

	const recall = await recallMemory({ cwd, url: "https://example.test/cart", query: "checkout portal" });
	assert.equal(recall.totalMatches, 0);
	assert.deepEqual(recall.cards, []);

	const plan = await buildMemoryAugmentationPlan(cwd, "https://example.test/cart", "checkout portal");
	assert.equal(plan, undefined);
});

test("frontmatter rejects legacy SOP kind instead of reinterpreting it as fact", async () => {
	const cwd = makeMemoryRoot();
	const legacyText = `---\nschemaVersion: 1\nid: legacy-sop-file\ntitle: Legacy SOP\nkind: sop\ntriggers:\n  - checkout portal\nscopeKind: origin\nscopeKey: https://example.test\nsensitivity: local\nstatus: active\nconfidence: verified\nverifiedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\nevidenceRefs: []\n---\nLegacy SOP body.\n`;
	writeFileSync(resolveMemoryPath(cwd, memoryEntryDir(), "legacy-sop-file.md"), legacyText, "utf8");

	assert.throws(
		() => parseMemoryEntry(legacyText, "facts/legacy-sop-file.md"),
		(error: unknown) => (error as { code?: string }).code === "MEMORY_SCHEMA_INVALID" && /kind must be fact/.test((error as Error).message),
	);
	const index = await writeDerivedMemoryIndex(cwd);
	assert.deepEqual(index.entries, []);
});

test("memory profile service handles disabled kernel, diagnostics consumption, and strike flushing", async () => {
	const cwd = makeMemoryRoot();
	const previous = process.env.BROWSER_PILOT_MEMORY;
	process.env.BROWSER_PILOT_MEMORY = "0";
	try {
		await recordMemoryProfileFrame({
			cwd,
			frame: {
				key: { browserSessionId: "disabled-session", navigationEpoch: "nav-disabled" },
				snapshotId: "snapshot-disabled",
				capturedAt: 1,
				facts: {},
				pageFingerprint: { changeSeq: 1, url: "https://disabled.test/app" },
			},
		});
		await recordMemoryProfileStrike({ cwd, origin: "https://disabled.test", entryId: "fact-1", status: "stale" });
		assert.equal(await readCachedMemoryProfile(cwd, "https://disabled.test"), undefined);
	} finally {
		if (previous === undefined) delete process.env.BROWSER_PILOT_MEMORY;
		else process.env.BROWSER_PILOT_MEMORY = previous;
	}

	assert.deepEqual(consumeMemoryProfileDiagnostics(cwd), []);
	const profilePath = memoryProfileFilePath(cwd, "https://example.test");
	mkdirSync(path.dirname(profilePath), { recursive: true });
	writeFileSync(profilePath, "{broken", "utf8");
	assert.equal(await readCachedMemoryProfile(cwd, "https://example.test"), undefined);
	assert.deepEqual(consumeMemoryProfileDiagnostics(cwd), ["memory_profile_unreadable"]);
	assert.deepEqual(consumeMemoryProfileDiagnostics(cwd), []);

	await recordMemoryProfileStrike({ cwd, origin: "https://example.test", entryId: "fact-1", status: "stale" });
	await drainMemoryProfileFlushes();
	let profile = (await readMemoryProfile(cwd, "https://example.test")).profile;
	assert.equal(profile?.strikes["fact-1"], 1);
	await recordMemoryProfileStrike({ cwd, origin: "https://example.test", entryId: "fact-1", status: "stale" });
	await drainMemoryProfileFlushes();
	profile = (await readMemoryProfile(cwd, "https://example.test")).profile;
	assert.equal(profile?.strikes["fact-1"], 1);
});

test("memory secret reader ignores malformed secrets and disabled creation", async () => {
	const cwd = makeMemoryRoot();
	const secretPath = memorySecretPath(cwd);
	mkdirSync(path.dirname(secretPath), { recursive: true });
	writeFileSync(secretPath, "not-a-hex-secret", "utf8");
	assert.equal(await readMemorySecret(cwd), undefined);
	const previous = process.env.BROWSER_PILOT_MEMORY;
	process.env.BROWSER_PILOT_MEMORY = "0";
	try {
		assert.equal(await readOrCreateMemorySecret(cwd), undefined);
	} finally {
		if (previous === undefined) delete process.env.BROWSER_PILOT_MEMORY;
		else process.env.BROWSER_PILOT_MEMORY = previous;
	}
});
