import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_ACTION_OUTCOME_ENTITIES,
	MAX_ACTION_OUTCOME_FEEDBACK,
	MAX_ACTION_OUTCOME_TEXT_CHARS,
	buildAbmlActionOutcome,
} from "../../src/kernels/abml/actionOutcome.ts";
import { diffEntities } from "../../src/kernels/abml/diff.ts";
import type { Entity, EntityState } from "../../src/kernels/abml/entity.ts";

const DEFAULT_STATE: EntityState = {
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
};

function entity(ref: string, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		state: { ...DEFAULT_STATE, ...overrides.state },
		source: "dom",
		...overrides,
	};
}

test("ABML action outcome verifies declared target state, name, and value from a stable post-model", () => {
	const targetRef = "bp-ref://control/save";
	const before = [entity(targetRef, { name: "Save", value: "draft", state: { ...DEFAULT_STATE, pressed: false } })];
	const after = [entity(targetRef, { name: "Saved", value: "published", state: { ...DEFAULT_STATE, pressed: true } })];
	const result = buildAbmlActionOutcome({
		action: {
			verb: "activate",
			targetRef,
			expected: { state: { pressed: true }, name: "Saved", value: "published" },
		},
		beforeEntities: before,
		afterEntities: after,
		diff: diffEntities(before, after),
		stability: "stable",
		elapsedMs: 42,
	});

	assert.equal(result.provider, "abml");
	assert.equal(result.effect.summary.hasSemanticEffect, true);
	assert.deepEqual(result.effect.target, {
		ref: targetRef,
		state: { pressed: { before: false, after: true } },
		name: { before: "Save", after: "Saved" },
		value: { before: "draft", after: "published" },
	});
	assert.equal(result.verification.status, "verified");
	assert.equal(result.verification.verb, "activate");
	assert.equal(result.verification.elapsedMs, 42);
	assert.equal(result.verification.observed.reason, "expectation_matched");
	assert.deepEqual(result.verification.observed.matched, ["state.pressed", "name", "value"]);
	assert.equal(result.verification.evidence.some((item) => item.kind === "target-expectation" && item.ref === targetRef), true);
});

test("ABML action outcome fails only stable explicit counterevidence and keeps unknown or changing evidence inconclusive", () => {
	const targetRef = "bp-ref://control/choice";
	const before = [entity(targetRef, { state: { ...DEFAULT_STATE, checked: false } })];
	const after = [entity(targetRef, { state: { ...DEFAULT_STATE, checked: false } })];
	const base = {
		action: { verb: "toggle", targetRef, expected: { state: { checked: true } } },
		beforeEntities: before,
		afterEntities: after,
		diff: diffEntities(before, after),
	} as const;

	const stable = buildAbmlActionOutcome({ ...base, stability: "stable" });
	assert.equal(stable.verification.status, "failed");
	assert.equal(stable.verification.observed.reason, "expectation_contradicted");
	assert.deepEqual(stable.verification.observed.contradicted, ["state.checked"]);

	const changing = buildAbmlActionOutcome({ ...base, stability: "changing" });
	assert.equal(changing.verification.status, "inconclusive");
	assert.equal(changing.verification.observed.reason, "post_state_not_stable");

	const unknown = buildAbmlActionOutcome({
		...base,
		action: { verb: "select", targetRef, expected: { state: { selected: true } } },
		stability: "stable",
	});
	assert.equal(unknown.verification.status, "inconclusive");
	assert.equal(unknown.verification.observed.reason, "expectation_not_observable");
	assert.deepEqual(unknown.verification.observed.unknown, ["state.selected"]);
});

test("ABML action outcome recognizes only fresh or updated perceptible alert/status feedback", () => {
	const before = [
		entity("bp-ref://region/status", { kind: "region", role: "status", name: "Saving" }),
		entity("bp-ref://region/stale", { kind: "region", role: "alert", name: "Old warning" }),
	];
	const after = [
		entity("bp-ref://region/status", { kind: "region", role: "STATUS", name: "Saved" }),
		entity("bp-ref://region/stale", { kind: "region", role: "alert", name: "Old warning" }),
		entity("bp-ref://region/new", { kind: "region", role: "alert", name: "Created" }),
		entity("bp-ref://region/hidden", { kind: "region", role: "status", name: "Hidden", state: { ...DEFAULT_STATE, visible: false } }),
		entity("bp-ref://region/generic", { kind: "region", role: "region", name: "Not live feedback" }),
	];
	const result = buildAbmlActionOutcome({
		action: { verb: "submit" },
		beforeEntities: before,
		afterEntities: after,
		diff: diffEntities(before, after),
		stability: "stable",
	});

	assert.equal(result.effect.feedback.count, 2);
	assert.deepEqual(result.effect.feedback.items, [
		{
			ref: "bp-ref://region/status",
			role: "status",
			freshness: "updated",
			name: "Saved",
			transition: { name: { before: "Saving", after: "Saved" } },
		},
		{ ref: "bp-ref://region/new", role: "alert", freshness: "appeared", name: "Created" },
	]);
	assert.equal(result.verification.status, "inconclusive");
	assert.equal(result.verification.observed.reason, "semantic_effect_without_expectation");
});

test("ABML action outcome bounds feedback and appeared/disappeared entity summaries", () => {
	const before = Array.from({ length: MAX_ACTION_OUTCOME_ENTITIES + 3 }, (_, index) => entity(`bp-ref://element/old-${index}`, {
		kind: "element",
		role: "listitem",
		name: `old-${index}`,
	}));
	const after = Array.from({ length: MAX_ACTION_OUTCOME_ENTITIES + 4 }, (_, index) => entity(`bp-ref://element/new-${index}`, {
		kind: "region",
		role: index < MAX_ACTION_OUTCOME_FEEDBACK + 2 ? "status" : "listitem",
		name: index === 0 ? "x".repeat(MAX_ACTION_OUTCOME_TEXT_CHARS + 100) : `new-${index}`,
	}));
	const result = buildAbmlActionOutcome({
		action: { verb: "refresh" },
		beforeEntities: before,
		afterEntities: after,
		diff: diffEntities(before, after),
		stability: "stable",
	});

	assert.equal(result.effect.appeared.count, after.length);
	assert.equal(result.effect.appeared.items.length, MAX_ACTION_OUTCOME_ENTITIES);
	assert.equal(result.effect.appeared.truncated, true);
	assert.equal(result.effect.disappeared.count, before.length);
	assert.equal(result.effect.disappeared.items.length, MAX_ACTION_OUTCOME_ENTITIES);
	assert.equal(result.effect.disappeared.truncated, true);
	assert.equal(result.effect.feedback.count, MAX_ACTION_OUTCOME_FEEDBACK + 2);
	assert.equal(result.effect.feedback.items.length, MAX_ACTION_OUTCOME_FEEDBACK);
	assert.equal(result.effect.feedback.truncated, true);
	assert.ok((result.effect.appeared.items[0]?.name?.length ?? 0) <= MAX_ACTION_OUTCOME_TEXT_CHARS);
});

test("ABML action outcome distinguishes an unverified semantic effect from no observed effect", () => {
	const appeared = [entity("bp-ref://region/result", { kind: "region", role: "region", name: "Result" })];
	const withEffect = buildAbmlActionOutcome({
		action: { verb: "activate" },
		beforeEntities: [],
		afterEntities: appeared,
		diff: diffEntities([], appeared),
		stability: "stable",
	});
	assert.equal(withEffect.verification.status, "inconclusive");
	assert.equal(withEffect.verification.observed.reason, "semantic_effect_without_expectation");
	assert.equal(withEffect.effect.summary.hasSemanticEffect, true);

	const withoutEffect = buildAbmlActionOutcome({
		action: { verb: "activate" },
		beforeEntities: [],
		afterEntities: [],
		diff: diffEntities([], []),
		stability: "stable",
	});
	assert.equal(withoutEffect.verification.status, "inconclusive");
	assert.equal(withoutEffect.verification.observed.reason, "no_semantic_effect");
	assert.equal(withoutEffect.effect.summary.hasSemanticEffect, false);
});
