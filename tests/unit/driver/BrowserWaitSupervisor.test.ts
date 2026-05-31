import test from "node:test";
import assert from "node:assert/strict";
import { computeBridgeGraceMs, computeReconnectBudgetMs } from "../../../src/driver/BrowserWaitSupervisor.ts";

test("BrowserWaitSupervisor computes smaller bridge grace for tight remaining deadlines", () => {
	assert.equal(computeBridgeGraceMs(2_000), 400);
	assert.equal(computeBridgeGraceMs(100), 50);
	assert.equal(computeBridgeGraceMs(0), 0);
});

test("BrowserWaitSupervisor caps bridge grace and reconnect budget for large deadlines", () => {
	assert.equal(computeBridgeGraceMs(30_000), 3_000);
	assert.equal(computeReconnectBudgetMs(30_000), 6_000);
	assert.equal(computeReconnectBudgetMs(100_000), 10_000);
});

test("BrowserWaitSupervisor reconnect budget never exceeds remaining deadline", () => {
	assert.equal(computeReconnectBudgetMs(40), 40);
	assert.equal(computeReconnectBudgetMs(250), 50);
	assert.equal(computeReconnectBudgetMs(2_000), 400);
});
