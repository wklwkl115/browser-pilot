import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { distilledTextResult, livePlaneSignature } = await import(new URL("../../../src/tools/resultMiddleware.ts", import.meta.url).href);
const { __buildMemoryAugmentationPlanForTests, __memoryWarmStartTermsForTests, __resetMemoryAugmentationStateForTests } = await import(new URL("../../../src/tools/observeRunners.ts", import.meta.url).href);
const { recordMemoryEntry } = await import(new URL("../../../src/tools/memory/store.ts", import.meta.url).href);
const { appendMemoryAutoSurface } = await import(new URL("../../../src/tools/memory/autoSurface.ts", import.meta.url).href);
const { writeMemoryProfile } = await import(new URL("../../../src/memory/profileStore.ts", import.meta.url).href);
const { recallByTokens } = await import(new URL("../../../src/memory-core/recall.ts", import.meta.url).href);

function freshCwd() {
	return mkdtempSync(path.join(os.tmpdir(), "memory-plane-"));
}

function makeArtifact(cwd) {
	const file = path.join(cwd, ".pi", "browser-artifacts", "evidence.json");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ ok: true }), "utf8");
	return file;
}

function trace(term = "checkout") {
	return { latestSeq: 1, terms: [{ term, kind: "urlPathToken", at: 1, seq: 1 }] };
}

function profileWithTerm(origin, term, capturedAt = 1) {
	const key = `urlPathToken\u0000${term.toLowerCase()}`;
	return {
		schemaVersion: 1,
		origin,
		sessions: [
			{ sessionId: `${term}-1`, capturedAt, termKeys: [key] },
			{ sessionId: `${term}-2`, capturedAt: capturedAt + 1, termKeys: [key] },
		],
		termStats: { [key]: { term, kind: "urlPathToken", sessionCount: 2, lastSeenAt: capturedAt + 1, weight: 1 } },
		urls: [],
		strikes: {},
	};
}

async function renderWithPlan(plan, maxChars = 12_000, toolName = "browser_observe", command = "scan") {
	const result = await distilledTextResult("Checkout page", {
		toolName,
		command,
		detailLevel: "summary",
		maxChars,
		fallbackName: "memory-plane.json",
		summary: { mode: "scan", url: "https://shop.example/checkout", focus: { gist: "Checkout page", outline: ["main"] } },
		entities: [{ ref: "pi-ref://control/pay", kind: "control", name: "Pay now" }],
		memoryAugmentationPlan: plan,
	});
	return JSON.parse(result.content[0].text);
}

// Disabled or empty store: no plan and no .pi/browser-memory materialization.
{
	const cwd = freshCwd();
	try {
		const plan = await __buildMemoryAugmentationPlanForTests(cwd, "https://shop.example/checkout", "checkout");
		assert.equal(plan, undefined);
		assert.equal(existsSync(path.join(cwd, ".pi", "browser-memory")), false, "empty automatic read must not materialize browser-memory");
		await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://shop.example/checkout", title: "Checkout", triggers: ["checkout"], body: "Use pay button.\n", evidenceRefs: [makeArtifact(cwd)] } });
		process.env.PI_BROWSER_MEMORY = "0";
		assert.equal(await __buildMemoryAugmentationPlanForTests(cwd, "https://shop.example/checkout", "checkout"), undefined, "PI_BROWSER_MEMORY=0 must disable memory plane");
		const nudged = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_execute", detailLevel: "summary", summary: { url: "https://new.example/" } } });
		assert.deepEqual(nudged.nextActions, undefined, "PI_BROWSER_MEMORY=0 must also disable the record nudge");
		delete process.env.PI_BROWSER_MEMORY;
	} finally {
		delete process.env.PI_BROWSER_MEMORY;
		await rm(cwd, { recursive: true, force: true });
	}
}

// Conversation-once economy: first plan carries inline, second collapses to handle-only.
{
	const cwd = freshCwd();
	try {
		__resetMemoryAugmentationStateForTests();
		await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://shop.example/checkout", title: "Checkout", triggers: ["checkout"], body: "Use pay button.\n", evidenceRefs: [makeArtifact(cwd)] } });
		const first = await __buildMemoryAugmentationPlanForTests(cwd, "https://shop.example/checkout", "checkout");
		const second = await __buildMemoryAugmentationPlanForTests(cwd, "https://shop.example/checkout", "checkout");
		assert(first?.inline, "first observe in a conversation should offer inline memory");
		assert(!second?.inline && second?.handleOnly, "second observe in the same conversation should collapse to handle-only");
		assert.equal(await __buildMemoryAugmentationPlanForTests(cwd, "https://shop.example/", "navigation search"), undefined, "same-origin memory plane must not surface without current-query token overlap");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

// Displacement ladder: inline accepted when live signature is unchanged; tight budget falls back
// to handle-only, and impossible memory is omitted.
{
	const base = await renderWithPlan(undefined);
	const inline = await renderWithPlan({ inline: { status: "matched", cards: [{ id: "sop_1", title: "Checkout", verification: "fresh", body: "Use pay button." }] } });
	assert.equal(inline.memory.cards[0].body, "Use pay button.");
	assert.equal(livePlaneSignature(inline), livePlaneSignature(base));
	const handle = await renderWithPlan({
		inline: { status: "matched", cards: [{ id: "sop_1", title: "Checkout", verification: "fresh", body: "x".repeat(10_000) }] },
		handleOnly: { status: "matched", collapsed: true, cards: [{ id: "sop_1", title: "Checkout", verification: "fresh", handle: "browser-memory://sop/sop_1" }] },
	}, 3_000);
	assert.equal(handle.memory.collapsed, true, "tight budget should accept handle-only when inline would displace live planes");
	assert.equal(livePlaneSignature(handle), livePlaneSignature(await renderWithPlan(undefined, 3_000)));
	const omitted = await renderWithPlan({
		inline: { status: "matched", cards: [{ id: "sop_1", title: "x".repeat(10_000), body: "x".repeat(10_000) }] },
		handleOnly: { status: "matched", cards: [{ id: "sop_1", title: "x".repeat(10_000), handle: "browser-memory://sop/sop_1" }] },
	}, 3_000);
	assert.equal(omitted.memory, undefined, "memory plane must be omitted when even handle-only changes live signature");
}

// Non-observe tools never carry the memory plane even if a caller accidentally passes a plan.
{
	const envelope = await renderWithPlan({ inline: { cards: [{ id: "sop_1", title: "Checkout" }] } }, 12_000, "browser_execute", "javascript");
	assert.equal(envelope.memory, undefined);
}

// Negative control: a wrong-origin profile and a same-origin/disjoint vocabulary profile must not
// activate memory F terms. Agreement with the live situation is required before F can appear.
{
	const cwd = freshCwd();
	try {
		await writeMemoryProfile(cwd, profileWithTerm("https://wrong.example", "checkout"));
		assert.deepEqual(await __memoryWarmStartTermsForTests(cwd, "https://shop.example/checkout", trace("checkout")), [], "wrong-origin profile must produce zero F activation");
		await writeMemoryProfile(cwd, profileWithTerm("https://shop.example", "dashboard"));
		assert.deepEqual(await __memoryWarmStartTermsForTests(cwd, "https://shop.example/checkout", { latestSeq: 1, terms: [] }), [], "same-origin memory still needs live-token agreement");
		const agreed = await __memoryWarmStartTermsForTests(cwd, "https://shop.example/checkout", trace("dashboard"));
		assert.equal(agreed.length, 1, "agreement-gated same-origin memory should activate exactly one F term");
		assert.equal(agreed[0].source, "F");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

// Negative control: stale anchors surface as stale, and a third strike suppresses the inline body.
{
	const cwd = freshCwd();
	try {
		__resetMemoryAugmentationStateForTests();
		const origin = "https://shop.example";
		const baseProfile = {
			schemaVersion: 1,
			origin,
			sessions: [],
			termStats: {},
			urls: [
				{ canonicalUrl: "https://shop.example/checkout", capturedAt: 2, fingerprintSummary: { changeSeq: 2 } },
				{ canonicalUrl: "https://shop.example/old", capturedAt: 1, fingerprintSummary: { changeSeq: 1 } },
			],
			strikes: {},
		};
		await writeMemoryProfile(cwd, baseProfile);
		const recorded = await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://shop.example/old", title: "Stale checkout SOP", triggers: ["checkout"], body: "Old checkout instructions should not inline after strike 3.\n", evidenceRefs: [makeArtifact(cwd)] } });
		await writeMemoryProfile(cwd, { ...baseProfile, strikes: { [recorded.entry.id]: 2 } });
		const plan = await __buildMemoryAugmentationPlanForTests(cwd, "https://shop.example/checkout", "checkout");
		const card = plan?.inline?.cards?.[0];
		assert.equal(card?.verification, "stale", "drifted anchors must be marked stale");
		assert.equal(card?.body, undefined, "third stale strike must suppress the memory body");
		assert.equal(card?.handle?.startsWith("browser-memory://sop/"), true, "stale cards remain recoverable by handle");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

// Negative control: common-token flood entries must not dominate a more specific memory candidate.
{
	const entries = [
		{ id: "common-1", title: "login page", triggers: ["page"], scopeKind: "origin", scopeKey: "https://shop.example", kind: "sop", status: "active", updatedAt: "2026-01-01T00:00:00.000Z" },
		{ id: "common-2", title: "login page", triggers: ["page"], scopeKind: "origin", scopeKey: "https://shop.example", kind: "sop", status: "active", updatedAt: "2026-01-03T00:00:00.000Z" },
		{ id: "specific", title: "checkout flow", triggers: ["checkout"], scopeKind: "origin", scopeKey: "https://shop.example", kind: "sop", status: "active", updatedAt: "2026-01-02T00:00:00.000Z" },
	];
	const recalled = recallByTokens(entries, { origin: "https://shop.example", tokens: ["login", "page", "checkout"] });
	assert.equal(recalled[0].entry.id, "specific", "IDF routing must keep common-token flood entries below the specific match");
}

console.log("memory plane contract ok");
