import assert from "node:assert/strict";
import test from "node:test";
import { buildObserveProviderPlan } from "../../src/kernels/abml/observeProviderPlan.ts";

function plan(overrides: Partial<Parameters<typeof buildObserveProviderPlan>[0]> = {}) {
	return buildObserveProviderPlan({
		now: 1_000,
		startedAt: 0,
		deadlineAt: 10_000,
		mode: "scan",
		cacheHit: false,
		outputBudgetChars: 20_000,
		hasBaseline: true,
		baselineHasNetworkSeq: true,
		baselineHasHookSeq: true,
		networkState: "unknown",
		hookState: "unknown",
		axeRequested: true,
		readabilityRequested: true,
		...overrides,
	});
}

test("observe provider plan preserves render reserve and deterministic 2:1:1 optional shares", () => {
	const value = plan();
	assert.equal(value.renderReserveMs, 1_000);
	assert.equal(value.optionalBudgetMs, 8_000);
	assert.deepEqual(
		Object.fromEntries(Object.entries(value.items).map(([provider, item]) => [provider, { planned: item.planned, reservedMs: item.reservedMs, reason: item.reason }])),
		{
			causal: { planned: true, reservedMs: 4_000, reason: "planned" },
			axe: { planned: true, reservedMs: 2_000, reason: "planned" },
			readability: { planned: true, reservedMs: 2_000, reason: "planned" },
		},
	);
	assert.deepEqual(value.statusProbe, { planned: true, reservedMs: 500, reason: "planned" });
});

test("observe provider plan skips before I/O when deadline, mode, cache, or output budget disallows optional work", () => {
	const deadline = plan({ now: 9_800, deadlineAt: 10_000 });
	assert.equal(deadline.optionalBudgetMs, 0);
	assert.ok(Object.values(deadline.items).every((item) => !item.planned && item.reason === "budget-preflight"));
	assert.equal(deadline.statusProbe.planned, false);

	for (const overrides of [{ mode: "text" as const }, { cacheHit: true }, { outputBudgetChars: 0 }]) {
		const value = plan(overrides);
		assert.ok(Object.values(value.items).every((item) => !item.planned));
		assert.equal(value.statusProbe.planned, false);
	}
});

test("observe provider plan never probes recorder state without causal demand and skips probes for known state", () => {
	const noBaseline = plan({ hasBaseline: false, baselineHasNetworkSeq: false, baselineHasHookSeq: false });
	assert.deepEqual(noBaseline.items.causal, { provider: "causal", planned: false, reservedMs: 4_000, reason: "not-required" });
	assert.deepEqual(noBaseline.statusProbe, { planned: false, reservedMs: 0, reason: "not-required" });

	const known = plan({ networkState: "active", hookState: "inactive" });
	assert.equal(known.items.causal.planned, true);
	assert.deepEqual(known.statusProbe, { planned: false, reservedMs: 0, reason: "known-state" });
});
