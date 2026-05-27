import test from "node:test";
import assert from "node:assert/strict";
import {
	baselineClusterKey,
	matchesStatusBodyResult,
	nearestBaselineByDistance,
	normalizeBaselineStrategy,
	responseChangeDelta,
	responseDeltaClassifier,
	responseReplayDelta,
	sameBaselineCluster,
} from "../../../../src/tools/webSecurity/shared/baseline.ts";

const left = {
	status: 200,
	title: "OK",
	bodyBytes: 120,
	bodySha256: "aaa",
	location: undefined,
};
const right = {
	status: 200,
	title: "OK",
	bodyBytes: 150,
	bodySha256: "bbb",
	location: undefined,
};

test("baseline normalizes strategy values", () => {
	assert.equal(normalizeBaselineStrategy("exact"), "exact");
	assert.equal(normalizeBaselineStrategy("cluster"), "cluster");
	assert.equal(normalizeBaselineStrategy("unexpected"), "auto");
});

test("baseline matches status/body filters", () => {
	assert.equal(matchesStatusBodyResult(200, 100, { matchStatus: [200], filterStatus: [], filterBodyBytes: [] }), true);
	assert.equal(matchesStatusBodyResult(404, 100, { matchStatus: [200], filterStatus: [], filterBodyBytes: [] }), false);
	assert.equal(matchesStatusBodyResult(200, 123, { matchStatus: [], filterStatus: [200], filterBodyBytes: [] }), false);
	assert.equal(matchesStatusBodyResult(200, 123, { matchStatus: [], filterStatus: [], filterBodyBytes: [123] }), false);
});

test("baseline cluster helpers classify similar responses", () => {
	assert.equal(baselineClusterKey(left), "200|OK|");
	assert.equal(sameBaselineCluster(left, right), true);
	assert.equal(sameBaselineCluster(left, { ...right, bodyBytes: 500 }), false);
});

test("baseline delta helpers expose response changes", () => {
	assert.deepEqual(responseChangeDelta(left, right), {
		statusChanged: false,
		titleChanged: false,
		bodyBytesDelta: 30,
		bodyHashChanged: true,
		locationChanged: false,
	});
	assert.deepEqual(responseDeltaClassifier(left, right), ["length", "body-hash"]);
	assert.equal(responseReplayDelta(left, right).classifier.includes("body-hash"), true);
});

test("baseline nearestBaselineByDistance chooses the closest fingerprint", () => {
	const result = nearestBaselineByDistance([
		{ ...left, title: "A" },
		{ ...left, title: "B", bodyBytes: 121 },
	], { ...left, title: "B", bodyBytes: 122 });
	assert.equal(result?.baseline.title, "B");
	assert.equal(typeof result?.distance, "number");
});
