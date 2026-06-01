import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const { recordMemoryEntry, recallMemory } = await import(new URL("../../../src/tools/memory/store.ts", import.meta.url).href);
const { appendMemoryAutoSurface, __resetMemoryAutoSurfaceState } = await import(new URL("../../../src/tools/memory/autoSurface.ts", import.meta.url).href);

function freshCwd() {
	return mkdtempSync(path.join(tmpdir(), "memory-autosurface-"));
}

function makeArtifact(cwd, name = "evidence.json") {
	const artifactPath = path.join(cwd, ".pi", "browser-artifacts", name);
	mkdirSync(path.dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, JSON.stringify({ ok: true }), "utf8");
	return artifactPath;
}

function observeEnvelope(url, extra = {}) {
	return { tool: "browser_observe", detailLevel: "summary", summary: { url, ...extra } };
}

function hintsOf(envelope) {
	return (envelope.nextActions || []).filter((line) => line.startsWith("relevant memory:"));
}

function recordHintsOf(envelope) {
	return (envelope.nextActions || []).filter((line) => line.startsWith("record candidate:"));
}

function savedEnvelope(url, savedPath, tool = "browser_execute") {
	return { tool, detailLevel: "summary", summary: { url }, saved: { path: savedPath } };
}

// 1. No memory recorded -> no hint, and index.json is NOT materialized.
{
	const cwd = freshCwd();
	const out = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	assert.deepEqual(hintsOf(out), [], "no memory must produce no hint");
	assert(!existsSync(path.join(cwd, ".pi", "browser-memory", "index.json")), "auto-surface must not materialize index.json for non-memory users");
}

// 2. Origin SOP surfaces exact-origin hint with counts.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs like", triggers: ["xiaohongshu", "like"], body: "1. step\n", evidenceRefs: [makeArtifact(cwd)] } });
	const out = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	const hints = hintsOf(out);
	assert.equal(hints.length, 1, "exact-origin match must surface one hint");
	assert(hints[0].includes("scopeKind=origin scopeKey=xiaohongshu.com") && hints[0].includes("(1 SOPs, 0 facts)"), `origin hint must carry scopeKind+scopeKey + counts: ${hints[0]}`);
	assert(hints[0].includes('top: "xhs like"'), `hint must name the top entry: ${hints[0]}`);
	// Mobile subdomain folds to the same origin and still surfaces.
	assert.equal(hintsOf(await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://m.xiaohongshu.com/explore") })).length, 1, "a device/variant subdomain must surface the apex origin's memory");
	// The hint must be executable: recalling with its args returns the entry.
	assert.equal((await recallMemory({ cwd, scopeKind: "origin", scopeKey: "xiaohongshu.com" })).length, 1, "origin hint's recall args must return the recorded card");
	// Robustness: a bare scopeKey (hint copied without scopeKind) must still resolve.
	assert.equal((await recallMemory({ cwd, scopeKey: "xiaohongshu.com" })).length, 1, "recall with bare scopeKey must default to origin scope and resolve");
	// Different origin -> no hint.
	const miss = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.com/") });
	assert.deepEqual(hintsOf(miss), [], "non-matching origin must not surface origin-scope memory");
}

// 3. mode=tabs and 4. env toggle suppress surfacing.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs", triggers: ["like"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const tabs = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore", { mode: "tabs" }) });
	assert.deepEqual(hintsOf(tabs), [], "mode=tabs must not surface memory");
	process.env["PI_BROWSER_MEMORY_AUTOSURFACE"] = "0";
	const off = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	delete process.env["PI_BROWSER_MEMORY_AUTOSURFACE"];
	assert.deepEqual(hintsOf(off), [], "PI_BROWSER_MEMORY_AUTOSURFACE=0 must disable surfacing");
}

// 5. Freshness (#4 regression): newly recorded memory surfaces in the SAME process.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "first", triggers: ["a"], body: "x\n", evidenceRefs: [makeArtifact(cwd, "a.json")] } });
	const first = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	assert(hintsOf(first)[0].includes("(1 SOPs, 0 facts)"), "first surface must see one SOP");
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "second", triggers: ["b"], body: "y\n", evidenceRefs: [makeArtifact(cwd, "b.json")] } });
	const second = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	assert(hintsOf(second)[0].includes("(2 SOPs, 0 facts)"), `freshly recorded memory must surface without restart: ${hintsOf(second)[0]}`);
}

// 6. Broadened triggers (#3 regression): non-observe tool with a target url surfaces.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs", triggers: ["like"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const exec = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_execute", detailLevel: "summary", summary: {}, target: { url: "https://www.xiaohongshu.com/explore" } } });
	assert.equal(hintsOf(exec).length, 1, "non-observe tool with origin must still surface memory");
	// browser_memory itself is skipped to avoid self-referential noise.
	const self = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_memory", detailLevel: "summary", summary: { url: "https://www.xiaohongshu.com/explore" } } });
	assert.deepEqual(hintsOf(self), [], "browser_memory results must not self-surface");
}

// 7. Task/project scope (#2 regression): surfaces via trigger match on the page.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", scopeKind: "task", scopeKey: "web-recon", title: "recon flow", triggers: ["recon", "endpoints"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const hit = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.com/recon", { title: "Recon dashboard" }) });
	const hints = hintsOf(hit);
	assert.equal(hints.length, 1, "task-scope memory must surface when a trigger matches the page");
	assert(hints[0].includes("scopeKind=task scopeKey=web-recon"), `task hint must carry scopeKind+scopeKey: ${hints[0]}`);
	const miss = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.com/profile", { title: "User profile" }) });
	assert.deepEqual(hintsOf(miss), [], "task-scope memory must stay silent when no trigger matches the page");
}

// 8. Record nudge (#1 ignition): uncovered origin + durable evidence -> one record
//    candidate, fired at most once per origin per session.
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	const out = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/scan.json")) });
	const rec = recordHintsOf(out);
	assert.equal(rec.length, 1, "uncovered origin with durable evidence must emit one record candidate");
	assert(rec[0].includes("action=record") && rec[0].includes("url=https://www.xiaohongshu.com/explore") && rec[0].includes("scan.json"), `record hint must carry record call + url + evidence: ${rec[0]}`);
	const again = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/scan2.json")) });
	assert.deepEqual(recordHintsOf(again), [], "record candidate must not repeat for the same origin in one session");
}

// 9. GA-style: evidence is optional — an action on an uncovered origin nudges
//    even without a saved artifact (the hint just omits evidenceRefs).
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	const out = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_execute", detailLevel: "summary", summary: { url: "https://www.xiaohongshu.com/explore" } } });
	const rec = recordHintsOf(out);
	assert.equal(rec.length, 1, "an action on an uncovered origin nudges even without durable evidence");
	assert(rec[0].includes("action=record") && !rec[0].includes("evidenceRefs="), `evidence-less record hint must omit evidenceRefs: ${rec[0]}`);
}

// 10. Covered origin -> recall hint, never a record nudge.
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs", triggers: ["like"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const out = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/scan.json")) });
	assert.equal(hintsOf(out).length, 1, "covered origin must still surface its recall hint");
	assert.deepEqual(recordHintsOf(out), [], "covered origin must not emit a record candidate");
}

// 11. env toggle disables the record nudge too.
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	process.env["PI_BROWSER_MEMORY_AUTOSURFACE"] = "0";
	const out = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/scan.json")) });
	delete process.env["PI_BROWSER_MEMORY_AUTOSURFACE"];
	assert.deepEqual(recordHintsOf(out), [], "PI_BROWSER_MEMORY_AUTOSURFACE=0 must disable the record nudge");
}

// 12. Salience: read-only tools (observe/screenshot/wait) never trigger the
//     record nudge even with durable evidence — looking is not accomplishing.
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	for (const tool of ["browser_observe", "browser_screenshot", "browser_wait"]) {
		const out = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/x.json"), tool) });
		assert.deepEqual(recordHintsOf(out), [], `${tool} must not emit a record candidate (read-only is not salient)`);
	}
	// An action tool on the same uncovered origin still nudges.
	const acted = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/x.json"), "browser_execute") });
	assert.equal(recordHintsOf(acted).length, 1, "an action tool on an uncovered origin must still nudge to record");
}

console.log("memory autosurface ok");
