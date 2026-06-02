// The disclosure layers (gist L0, outline L1) live in summary.focus, which fitSummaryBudget
// can squeeze away on a big page (minimalBase). responseEnvelope lifts them to the envelope
// top-level from the UNcompressed summary (like entities), so the agent always gets a cheap
// page overview + container fold regardless of the summary budget. This locks that in.
import test from "node:test";
import assert from "node:assert/strict";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";

async function envelopeFor(summary: Record<string, unknown>, maxChars = 40_000): Promise<Record<string, unknown>> {
	const result = await distilledTextResult("body text", { toolName: "browser_observe", command: "scan", detailLevel: "detailed", maxChars, fallbackName: "observe-scan", summary });
	return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test("gist/outline are lifted to the envelope top-level", async () => {
	const envelope = await envelopeFor({
		abmlIntegrated: true,
		focus: {
			gist: { landmarks: ["main", "form"], controlCount: 3, statefulControlCount: 3, activeControlCount: 1, containerCount: 1 },
			outline: [{ container: "radiogroup", name: "Crust", memberCount: 3, memberRefs: ["a", "b", "c"] }],
			primary_entities: [{ ref: "pi-ref://control/1", kind: "control", role: "radio", name: "A" }],
		},
	});
	const gist = envelope.gist as Record<string, unknown> | undefined;
	assert.ok(gist, "gist present at envelope top-level");
	assert.equal(gist!.controlCount, 3);
	const outline = envelope.outline as Array<Record<string, unknown>> | undefined;
	assert.ok(Array.isArray(outline) && outline.length === 1, "outline present at envelope top-level");
	assert.equal(outline![0]!.name, "Crust");
});

test("gist/outline survive the summary-budget squeeze (lifted from the uncompressed summary)", async () => {
	// Pad primary_entities so the summary trips fitSummaryBudget on a tight budget; the focus
	// aggregate may get squeezed, but the top-level gist/outline must remain intact.
	const primary_entities = Array.from({ length: 30 }, (_, i) => ({ ref: `pi-ref://control/${i}`, kind: "control", role: "radio", name: `option ${i} ${"pad ".repeat(60)}` }));
	const envelope = await envelopeFor({
		abmlIntegrated: true,
		focus: {
			gist: { landmarks: ["main"], controlCount: 30, statefulControlCount: 30, activeControlCount: 2, containerCount: 1 },
			outline: [{ container: "radiogroup", name: "Big group", memberCount: 30, memberRefs: ["a", "b", "c"] }],
			primary_entities,
		},
	}, 3_000);
	const gist = envelope.gist as Record<string, unknown> | undefined;
	assert.ok(gist, "gist still present after budget squeeze");
	assert.equal(gist!.controlCount, 30);
	const outline = envelope.outline as Array<Record<string, unknown>> | undefined;
	assert.ok(Array.isArray(outline) && outline![0]!.name === "Big group", "outline still present after budget squeeze");
});

test("abmlIntegrated + disclosure layers form a stable envelope contract under a tight budget", async () => {
	// When AX merge is integrated, observe's envelope must expose abmlIntegrated + gist +
	// outline + entities at the top level regardless of the summary budget — the "stable,
	// not budget-squeezable" disclosure contract the tool consumer asked for.
	const envelope = await envelopeFor({
		abmlIntegrated: true,
		focus: {
			gist: { landmarks: ["main"], controlCount: 2, containerCount: 1 },
			outline: [{ container: "radiogroup", name: "Crust", memberCount: 2, controlCount: 2, memberRefs: ["a", "b"] }],
			primary_entities: [{ ref: "pi-ref://control/1", kind: "control", role: "radio", name: "A", state: { checked: true } }],
		},
	}, 2_000);
	assert.equal(envelope.abmlIntegrated, true, "abmlIntegrated surfaced at envelope top-level");
	assert.equal(typeof envelope.gist, "object", "gist is an object");
	assert.ok(Array.isArray(envelope.outline), "outline is an array");
	assert.ok(Array.isArray(envelope.entities), "entities is an array");
});

test("abmlIntegrated:false is surfaced too (agent can tell AX merge did NOT apply)", async () => {
	const envelope = await envelopeFor({ abmlIntegrated: false, focus: { primary_entities: [] } });
	assert.equal(envelope.abmlIntegrated, false, "abmlIntegrated:false is visible, never omitted");
});
