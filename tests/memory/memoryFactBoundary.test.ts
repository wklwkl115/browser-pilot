import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMemoryAugmentationPlan } from "../../src/commands/observe/memoryAugmentation.ts";
import { readBrowserMemory } from "../../src/commands/memory/reader.ts";
import { recallMemory, recordMemoryEntry, validateMemoryRecord } from "../../src/commands/memory/store.ts";
import { validateMemoryRecordPayloadShape } from "../../src/commands/memory/evidence.ts";
import { parseMemoryEntry, serializeMemoryEntry } from "../../src/memory/frontmatter.ts";
import { readMemoryIndex, writeDerivedMemoryIndex } from "../../src/memory/indexStore.ts";
import { memoryEntryDir, resolveMemoryPath } from "../../src/memory/paths.ts";
import { clearResourceStore, registerBrowserResultResource, resolveResourceUri } from "../../src/resources/resourceRefs.ts";
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
