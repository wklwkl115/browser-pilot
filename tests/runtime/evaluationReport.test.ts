import test from "node:test";
import assert from "node:assert/strict";

const { parseEvaluationArgs, summarizeAttempts } = await import(
	new URL("../../scripts/lib/evaluation-metrics.mjs", import.meta.url).href
);

test("browser evaluation summaries include failures and separate success latency", () => {
	const attempts = [10, 20, 30, 100].map((durationMs, index) => ({
		durationMs,
		success: index !== 3,
		toolCalls: 2,
		responseJsonBytes: 100,
		responseTextChars: 40,
		...(index === 3 ? { failure: { category: "verification", code: "unmet" } } : {}),
	}));
	const summary = summarizeAttempts(attempts);
	assert.equal(summary.attempted, 4);
	assert.equal(summary.passed, 3);
	assert.equal(summary.failed, 1);
	assert.equal(summary.successRate, 0.75);
	assert.deepEqual(summary.latencyMs, { count: 4, p50: 20, p95: 100, max: 100 });
	assert.deepEqual(summary.successLatencyMs, { count: 3, p50: 20, p95: 30, max: 30 });
	assert.equal(summary.toolCalls, 8);
	assert.equal(summary.responseJsonBytes, 400);
	assert.equal(summary.responseTextChars, 160);
	assert.deepEqual(summary.errors, { "verification:unmet": 1 });
	assert.equal(attempts[0]!.durationMs, 10);
});

test("an empty evaluation does not report a perfect success rate", () => {
	const summary = summarizeAttempts([]);
	assert.equal(summary.successRate, null);
	assert.equal(summary.latencyMs.p95, null);
	assert.equal(summary.attempted, 0);
});

test("browser evaluation arguments reject missing values, partial numbers, and unknown switches", () => {
	assert.deepEqual(parseEvaluationArgs(["--quiet", "--rounds", "2", "--output", "report.json"]), {
		rounds: 2,
		output: "report.json",
	});
	for (const args of [
		["--rounds"],
		["--rounds", "2x"],
		["--rounds", "0"],
		["--rounds", "51"],
		["--output"],
		["--url", "https://example.invalid"],
	])
		assert.throws(() => parseEvaluationArgs(args));
});
