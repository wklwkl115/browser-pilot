import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const { recordMemoryEntry } = await import(new URL("../../../src/tools/memory/store.ts", import.meta.url).href);
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

// 2. Origin SOP no longer surfaces recall hints here; recall moved into
//    browser_observe envelope.memory so nextActions stays focused on record nudge.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs like", triggers: ["xiaohongshu", "like"], body: "1. step\n", evidenceRefs: [makeArtifact(cwd)] } });
	const out = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	assert.deepEqual(hintsOf(out), [], "exact-origin memory must not surface a recall hint from autoSurface");
	assert.deepEqual(hintsOf(await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://m.xiaohongshu.com/explore") })), [], "device/variant subdomain must not surface recall hints from autoSurface");
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

// 5. Freshness regression now belongs to envelope.memory; autoSurface remains silent.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "first", triggers: ["a"], body: "x\n", evidenceRefs: [makeArtifact(cwd, "a.json")] } });
	const first = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	assert.deepEqual(hintsOf(first), [], "first recorded memory must not use autoSurface recall hints");
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "second", triggers: ["b"], body: "y\n", evidenceRefs: [makeArtifact(cwd, "b.json")] } });
	const second = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://www.xiaohongshu.com/explore") });
	assert.deepEqual(hintsOf(second), [], "freshly recorded memory must not use autoSurface recall hints");
}

// 6. Non-observe tool with a covered target url stays quiet: no recall hint and no record nudge.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs", triggers: ["like"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const exec = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_execute", detailLevel: "summary", summary: {}, target: { url: "https://www.xiaohongshu.com/explore" } } });
	assert.deepEqual(hintsOf(exec), [], "non-observe tool must not surface recall memory through autoSurface");
	assert.deepEqual(recordHintsOf(exec), [], "covered origin must not emit a record nudge");
	// browser_memory itself is skipped to avoid self-referential noise.
	const self = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_memory", detailLevel: "summary", summary: { url: "https://www.xiaohongshu.com/explore" } } });
	assert.deepEqual(hintsOf(self), [], "browser_memory results must not self-surface");
}

// 7. Task/project scope recall hints are not emitted by autoSurface.
{
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", scopeKind: "task", scopeKey: "web-recon", title: "recon flow", triggers: ["recon", "endpoints"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const hit = await appendMemoryAutoSurface({ cwd, envelope: observeEnvelope("https://example.com/recon", { title: "Recon dashboard" }) });
	assert.deepEqual(hintsOf(hit), [], "task-scope memory must not surface from autoSurface");
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

// 9b. G12: execute without page context preserves old behavior and stays quiet.
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	const out = await appendMemoryAutoSurface({ cwd, envelope: { tool: "browser_execute", detailLevel: "summary", summary: {} } });
	assert.deepEqual(recordHintsOf(out), [], "execute without url must not emit a record candidate");
}

// 10. Covered origin -> no recall hint here, never a record nudge.
{
	__resetMemoryAutoSurfaceState();
	const cwd = freshCwd();
	await recordMemoryEntry({ cwd, payload: { kind: "sop", url: "https://www.xiaohongshu.com/explore", title: "xhs", triggers: ["like"], body: "x\n", evidenceRefs: [makeArtifact(cwd)] } });
	const out = await appendMemoryAutoSurface({ cwd, envelope: savedEnvelope("https://www.xiaohongshu.com/explore", path.join(cwd, ".pi/browser-artifacts/scan.json")) });
	assert.deepEqual(hintsOf(out), [], "covered origin must not surface recall hints from autoSurface");
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
