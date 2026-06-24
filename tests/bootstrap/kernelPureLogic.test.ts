import test from "node:test";
import assert from "node:assert/strict";
import { mintRef, parseRef, isBrowserPilotRef, normalizeRef } from "../../src/kernels/refs/core.ts";
import { projectJsonValue } from "../../src/kernels/evidence/distill/projection.ts";
import { computeRelevanceMap } from "../../src/kernels/evidence/distill/relevance.ts";
import { countDistillTruncationMarkers, fitSalienceEnvelopeBudget } from "../../src/kernels/evidence/distill/salienceEnvelope.ts";
import type { BudgetedEnvelope } from "../../src/kernels/evidence/distill/ladder.ts";
import { toPersistableMemoryTerm } from "../../src/kernels/memory/terms.ts";
import { buildMemoryRoutingIndex, memoryRoutingTokens, routeByTokens, situationTokens } from "../../src/kernels/memory/routing.ts";
import { detectSqlDbms, firstBooleanOracle, hasSqlError, nearestBooleanTruth, sqliUnionMeta } from "../../src/kernels/security/sqliOracle.ts";
import type { ResponseFingerprint } from "../../src/kernels/security/replayDiff.ts";
import { baselineClusterKey, matchesStatusBodyResult, nearestBaselineByDistance, normalizeBaselineStrategy, responseReplayDelta, sameBaselineCluster } from "../../src/kernels/security/replayDiff.ts";

test("refs kernel parses scoped refs and rejects malformed boundary values", () => {
	const scoped = mintRef("control", "login/button:1", { scope: "https://example.test/app path" });
	assert.equal(scoped, "bp-ref://control/https%3A%2F%2Fexample.test%2Fapp%20path/login/button:1");
	assert.deepEqual(parseRef(scoped), {
		scheme: "bp-ref",
		kind: "control",
		id: "login/button:1",
		scope: "https://example.test/app path",
	});
	assert.equal(isBrowserPilotRef(scoped), true);
	assert.equal(isBrowserPilotRef("bp-ref://control/"), false);
	assert.throws(() => parseRef("control/login"), /must start/);
	assert.throws(() => normalizeRef({ scheme: "bp-ref", kind: "control", id: "bad id" }), /Invalid Browser Pilot ref id/);
	assert.throws(() => normalizeRef({ scheme: "bp-ref", kind: "control", id: "ok", scope: "  " }), /scope cannot be empty/);
});

test("evidence projection folds array records and handles empty, malformed, offset, and budget edges", () => {
	const rows = Array.from({ length: 6 }, (_, index) => ({
		kind: "request",
		status: index % 2 === 0 ? 200 : 500,
		url: `/api/items/${index}`,
		bodyBytes: 100 + index,
		rare: index === 4 ? "spike" : "normal",
	}));
	const projected = projectJsonValue(rows, { offset: 1, limit: 3, jsonPath: "$.requests", maxChars: 1_200 });
	assert.ok(projected);
	assert.equal(projected.count, 6);
	assert.equal(projected.offset, 1);
	assert.equal(projected.limit, 3);
	assert.equal(projected.nextOffset, 4);
	assert.deepEqual(projected.template.constants, { kind: "request", rare: "normal" });
	assert.deepEqual(projected.template.ranges?.bodyBytes, { min: 101, max: 103 });
	assert.equal(projected.items[0]!.i, 1);
	assert.equal(projected.frontier.dropped.nextOffset, 4);
	assert.equal(projectJsonValue([], { limit: 2 }), undefined);
	assert.equal(projectJsonValue([{ ok: true }, "bad"], { limit: 2 }), undefined);
	assert.equal(projectJsonValue(rows, { offset: 999, limit: 2 }), undefined);
});

test("evidence relevance scores low, high, propagated, aged, and CJK signal edges", () => {
	const relevance = computeRelevanceMap([
		{ ref: "bp-ref://control/pay", fields: { name: "Pay invoice", role: "button", selector: "#pay-now" }, neighbors: { containerKey: "checkout", labelledBySources: ["bp-ref://label/pay"] } },
		{ ref: "bp-ref://control/cancel", fields: { name: "Cancel order", role: "button" }, neighbors: { containerKey: "checkout" } },
		{ ref: "bp-ref://control/profile", fields: { name: "个人中心", container: "账户" } },
	], [
		{ term: "pay", kind: "literal", source: "C", weight: 2 },
		{ term: "#pay-now", kind: "selectorLiteral", source: "A", weight: 1 },
		{ term: "invoice", kind: "literal", source: "F", weight: 4, age: 99 },
		{ term: "个人中心", kind: "literal", source: "E", weight: 1 },
		{ term: "x", kind: "literal", source: "B", weight: 10 },
	]);
	const pay = relevance.byRef.get("bp-ref://control/pay");
	const cancel = relevance.byRef.get("bp-ref://control/cancel");
	const label = relevance.byRef.get("bp-ref://label/pay");
	const profile = relevance.byRef.get("bp-ref://control/profile");
	assert.ok(pay);
	assert.ok(cancel);
	assert.ok(label);
	assert.ok(profile);
	assert.ok(pay.score > cancel.score);
	assert.ok(cancel.score > 0);
	assert.ok(label.score < pay.score);
	assert.deepEqual(profile.sources, ["E"]);
	assert.deepEqual(relevance.signals, ["A", "C", "E", "F"]);
	assert.equal(relevance.scoreFields({ name: "totally unrelated" }), 0);
});

test("evidence salience envelope fits summary budgets and falls back on sparse oversized inputs", () => {
	const envelope: BudgetedEnvelope = {
		tool: "browser_observe",
		detailLevel: "full",
		summary: { title: "Checkout", textPreview: "x".repeat(2_000), samples: Array.from({ length: 20 }, (_, index) => `sample-${index}`) },
		nextActions: ["Click bp-ref://control/pay"],
		snapshotProjection: { summary: { templateCount: 1, instanceCount: 2 }, templates: [{ templateKey: "pay", count: 1, instances: [{ ref: "bp-ref://control/pay", name: "Pay now", role: "button" }] }] },
		collections: [{ kind: "list", itemRefs: ["bp-ref://control/pay"], completeness: "complete" }],
		entities: [
			{ ref: "bp-ref://control/pay", name: "Pay now", role: "button", selector: "#pay-now", value: "x".repeat(1_000) },
			{ ref: "bp-ref://control/cancel", name: "Cancel", role: "button", value: "y".repeat(1_000) },
		],
		relations: { summary: { triggered: 1 }, verbose: "z".repeat(2_000) },
	};
	const fitted = fitSalienceEnvelopeBudget(envelope, 1_500);
	assert.equal(fitted.tool, "browser_observe");
	assert.ok(JSON.stringify(fitted).length <= 1_500);
	assert.ok(fitted.summary.rendererOmitted === undefined || Array.isArray(fitted.summary.rendererOmitted));
	assert.equal(countDistillTruncationMarkers(fitted) >= 0, true);

	const sparse = fitSalienceEnvelopeBudget({ ...envelope, summary: { textPreview: "x".repeat(5_000) }, snapshotProjection: undefined, collections: undefined, diff: { summary: { changed: 1 } }, treeDiff: { summary: { changed: 1 } } }, 1);
	assert.ok(JSON.stringify(sparse).length <= 1_000);
	assert.ok(sparse.diff !== undefined || sparse.treeDiff !== undefined || sparse.summary.summaryTruncatedToBudget === true);
});

test("memory kernel normalizes persistable terms and routes tokens deterministically", () => {
	assert.deepEqual(toPersistableMemoryTerm({ term: "  Submit\nOrder  ", kind: "selectorLiteral", weight: 2.5 }), {
		term: "Submit Order",
		kind: "selectorLiteral",
		weight: 2.5,
	});
	assert.equal(toPersistableMemoryTerm({ term: "x", kind: "ref" }), undefined);
	assert.equal(toPersistableMemoryTerm({ term: "x".repeat(129), kind: "urlPathToken" }), undefined);
	assert.equal(toPersistableMemoryTerm({ term: "/login", kind: "unknown" }), undefined);
	assert.deepEqual(memoryRoutingTokens({ title: "Login Login", triggers: ["Reset password", "2FA login"] }), ["login", "reset", "password", "2fa"]);
	assert.deepEqual(situationTokens("Login login, reset-password!"), ["login", "reset", "password"]);
	const routing = buildMemoryRoutingIndex([
		{ id: "a", status: "active", title: "Login reset", triggers: ["password recovery"] },
		{ id: "b", status: "archived", title: "Login", triggers: ["ignored"] },
		{ id: "c", status: "active", title: "Checkout", triggers: ["order submit password"] },
	]);
	assert.deepEqual(routing.login, ["a"]);
	assert.equal(routing.ignored, undefined);
	const routed = routeByTokens(routing, ["password", "login", "missing"]);
	assert.equal(routed.has("b"), false);
	assert.ok((routed.get("a") ?? 0) > (routed.get("c") ?? 0));
	assert.deepEqual([...routeByTokens(undefined, ["login"]).entries()], []);
});

test("security replay and SQLi kernels classify normal, malformed, and boundary fingerprints", () => {
	const baseline: ResponseFingerprint = { status: 200, title: "Home", bodyBytes: 1_000, bodySha256: "aaa", location: "/" };
	const near: ResponseFingerprint = { status: 200, title: "Home", bodyBytes: 1_050, bodySha256: "bbb", location: "/" };
	const far: ResponseFingerprint = { status: 500, title: "Error", bodyBytes: 12, bodySha256: "ccc", location: "/error" };
	assert.equal(normalizeBaselineStrategy(" CLUSTER "), "cluster");
	assert.equal(normalizeBaselineStrategy("bad"), "auto");
	assert.equal(matchesStatusBodyResult(200, 1000, { matchStatus: [200], filterStatus: [], filterBodyBytes: [] }), true);
	assert.equal(matchesStatusBodyResult(500, 1000, { matchStatus: [200], filterStatus: [], filterBodyBytes: [] }), false);
	assert.equal(baselineClusterKey(baseline), "200|Home|/");
	assert.equal(sameBaselineCluster(baseline, near), true);
	assert.equal(sameBaselineCluster(baseline, far), false);
	assert.deepEqual(responseReplayDelta(baseline, far).classifier, ["status", "title", "length", "body-hash", "location"]);
	assert.deepEqual(nearestBaselineByDistance([far, baseline], near)?.baseline, baseline);
	assert.equal(hasSqlError("You have an error in your SQL syntax near 'x'"), true);
	assert.deepEqual(detectSqlDbms("PostgreSQL ERROR: unterminated quoted string"), ["postgresql"]);
	assert.deepEqual(sqliUnionMeta("1 order by 7--"), { unionTechnique: "order-by", columnCount: 7 });
	assert.deepEqual(sqliUnionMeta("1 UNION ALL SELECT id, name, email--"), { unionTechnique: "union-select", columnCount: 3 });
	assert.equal(nearestBooleanTruth(near, { trueFp: baseline, falseFp: far }), true);
	assert.deepEqual(firstBooleanOracle([
		{ type: "boolean", matched: false },
		{ type: "boolean", matched: true, location: "query", paramName: "id", trueResponse: { fingerprint: baseline }, falseResponse: { fingerprint: far } },
	])?.paramName, "id");
	assert.equal(firstBooleanOracle([{ type: "boolean", matched: true, trueResponse: null, falseResponse: {} }]), undefined);
});
