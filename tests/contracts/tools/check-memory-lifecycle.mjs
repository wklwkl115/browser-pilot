import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const { recordMemoryEntry, recallMemory } = await import(new URL("../../../src/tools/memory/store.ts", import.meta.url).href);
const { readMemoryIndex } = await import(new URL("../../../src/tools/memory/indexStore.ts", import.meta.url).href);
const { readBrowserMemory } = await import(new URL("../../../src/tools/memory/reader.ts", import.meta.url).href);

const cwd = mkdtempSync(path.join(tmpdir(), "memory-lifecycle-"));
const artifactPath = path.join(cwd, ".pi", "browser-artifacts", "evidence.json");
mkdirSync(path.dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, JSON.stringify({ ok: true }), "utf8");

const rec = (title) => recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.site.com/x", title, triggers: ["t"], body: "1. step\n", evidenceRefs: [artifactPath] } });

// Supersede: same title twice -> old tombstoned, only newest active.
const a = await rec("same title");
const b = await rec("same title");
assert.deepEqual(b.supersededIds, [a.entry.id], "second record must supersede the first by id");

const idx = await readMemoryIndex(cwd);
const active = idx.entries.filter((e) => e.status === "active");
const deprecated = idx.entries.filter((e) => e.status === "deprecated");
assert.equal(active.length, 1, "exactly one active entry after supersede");
assert.equal(active[0].id, b.entry.id, "the surviving active entry is the newest");
assert.equal(deprecated.length, 1, "the superseded entry is marked deprecated");

// byScope is a live-scope set: deprecated ids must not leak into it.
assert.deepEqual(idx.byScope["origin:site.com"], [b.entry.id], "byScope must list only active ids");

// Recall surfaces only active entries.
const cards = await recallMemory({ cwd, scopeKind: "origin", scopeKey: "site.com" });
assert.equal(cards.length, 1, "recall must return only the active entry");
assert.equal(cards[0].id, b.entry.id, "recall returns the surviving entry");

// A deprecated entry stays readable by id (handle still resolves).
const readDeprecated = await readBrowserMemory({ cwd, id: a.entry.id, mode: "text", offset: 1, limit: 5 });
assert.equal(readDeprecated.mode, "text", "deprecated entry must still be readable by id");
assert(readDeprecated.snippets[0]?.text.includes("step"), "deprecated entry body must still be returned");

// A distinct-title entry coexists -> two active, byScope has both.
const c = await recordMemoryEntry({ cwd, payload: { kind: "fact", url: "https://www.site.com/x", title: "a fact", triggers: ["t"], body: "note\n", evidenceRefs: [artifactPath] } });
const idx2 = await readMemoryIndex(cwd);
assert.equal(idx2.entries.filter((e) => e.status === "active").length, 2, "distinct-title entry coexists with the active SOP");
assert.deepEqual(new Set(idx2.byScope["origin:site.com"]), new Set([b.entry.id, c.entry.id]), "byScope tracks all active ids in scope");

const cards2 = await recallMemory({ cwd, scopeKind: "origin", scopeKey: "site.com" });
assert.equal(cards2.length, 2, "recall returns both active entries");

// --- salience / dedup (write side) ---
const recDedup = (title, body) => recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://dedup.com/x", title, triggers: ["login", "auth"], body, evidenceRefs: [artifactPath] } });
const LOGIN_BODY = "navigate then submit credentials and verify\n";

// A reworded near-identical SOP auto-supersedes instead of accumulating a copy.
const d1 = await recDedup("login flow", "open page, click submit, read result\n");
const d2 = await recDedup("login flow", LOGIN_BODY);
assert.deepEqual(d2.supersededIds, [d1.entry.id], "a reworded near-identical SOP must supersede the prior one");
assert.equal((await recallMemory({ cwd, scopeKind: "origin", scopeKey: "dedup.com" })).length, 1, "dedup keeps a single active SOP for the flow");

// A genuinely distinct flow on the same origin coexists (not merged).
const d3 = await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://dedup.com/x", title: "checkout payment", triggers: ["checkout", "pay"], body: "add to cart, pay, confirm order\n", evidenceRefs: [artifactPath] } });
assert.deepEqual(d3.supersededIds, [], "a distinct flow must not be superseded");
assert.equal((await recallMemory({ cwd, scopeKind: "origin", scopeKey: "dedup.com" })).length, 2, "distinct flows coexist");

// A merely-similar entry (different title, shared triggers+body) is flagged as a
// soft duplicate candidate, not merged.
const d4 = await recDedup("authenticate", LOGIN_BODY);
assert.deepEqual(d4.supersededIds, [], "a merely-similar entry must not be auto-superseded");
assert(d4.duplicateCandidates.some((c) => c.id === d2.entry.id), "the similar prior entry must be surfaced as a duplicate candidate");
assert.equal((await recallMemory({ cwd, scopeKind: "origin", scopeKey: "dedup.com" })).length, 3, "a soft-similar entry still coexists");

// --- L1 insight index (routing) ---
const idxR = await readMemoryIndex(cwd);
assert(idxR.routing && typeof idxR.routing === "object" && !Array.isArray(idxR.routing), "index must carry an L1 routing token index");

const rA = await recordMemoryEntry({ cwd, payload: { kind: "sop", scopeKind: "task", scopeKey: "t-recon", title: "recon endpoints sweep", triggers: ["recon", "endpoints"], body: "x\n", evidenceRefs: [] } });
await recordMemoryEntry({ cwd, payload: { kind: "sop", scopeKind: "task", scopeKey: "t-login", title: "login flow", triggers: ["login"], body: "y\n", evidenceRefs: [] } });
// A multi-keyword query routes across scopes by token overlap, best match first.
const routedCards = await recallMemory({ cwd, query: "recon endpoints" });
assert.equal(routedCards[0].id, rA.entry.id, "multi-keyword query must route to the best token-overlap match first");
assert(routedCards[0].matchReason.includes("route"), `routing must show in matchReason: ${routedCards[0].matchReason}`);
// A query token that matches nothing routes to nobody.
assert.equal((await recallMemory({ cwd, query: "nonexistenttoken" })).length, 0, "an unmatched query routes to no cards");

// A dominant single match inlines its bounded body (saves a follow-up read);
// every card carries updatedAt for freshness judgement.
assert(routedCards[0].body && routedCards[0].body.length > 0, "a dominant single recall match must inline its bounded body");
assert(typeof routedCards[0].updatedAt === "string" && routedCards[0].updatedAt.length > 0, "recall cards must carry updatedAt");
// Ambiguous recall (several equal exact-origin matches) must NOT inline a body.
const ambiguous = await recallMemory({ cwd, scopeKind: "origin", scopeKey: "dedup.com" });
assert(ambiguous.length >= 2 && ambiguous[0].body === undefined, "ambiguous recall must not inline a body");

// An over-long inlined body is bounded with an ellipsis (≤60 lines).
const longBody = `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")}\n`;
await recordMemoryEntry({ cwd, payload: { kind: "sop", scopeKind: "task", scopeKey: "t-long", title: "verbose walkthrough", triggers: ["verbose", "walkthrough"], body: longBody, evidenceRefs: [] } });
const longCard = (await recallMemory({ cwd, query: "verbose walkthrough" }))[0];
assert(longCard.body.endsWith("…"), "an over-long inlined body must be truncated with an ellipsis");
assert(longCard.body.split(/\r?\n/).length <= 61, `inlined body must be capped near the line limit: ${longCard.body.split(/\r?\n/).length}`);

console.log("memory lifecycle ok");
