import test from "node:test";
import assert from "node:assert/strict";

const { parseEvaluationArgs, summarizeAttempts, selectEvaluationTasks } = await import(
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
	assert.equal(summary.recoverableGaps.successRate, null);
});

test("equivalent-need summaries cannot promote partial or budget-exhausted comparisons", () => {
	const summary = summarizeAttempts([
		{
			success: true,
			durationMs: 1,
			toolCalls: 1,
			responseJsonBytes: 1,
			responseTextChars: 1,
			equivalentNeedCosts: {
				allPathsSatisfied: true,
				paths: {
					page: { status: "satisfied" },
					wholeGroup: { status: "unsatisfied" },
					progressivePacket: { status: "budget-exhausted" },
				},
			},
		},
	]);
	assert.deepEqual(summary.equivalentNeeds, {
		comparisons: 1,
		comparableComparisons: 0,
		satisfiedPaths: 1,
		unsatisfiedPaths: 1,
		budgetExhaustedPaths: 1,
		missingPaths: 0,
	});
});

test("recoverable gap metrics count failures without equating resource reads with recovery", () => {
	const summary = summarizeAttempts([
		{
			success: true,
			durationMs: 1,
			toolCalls: 1,
			responseJsonBytes: 1,
			responseTextChars: 1,
			recoverableGaps: { attempted: 2, addressed: 1 },
			resourceReads: 9,
		},
		{
			success: false,
			durationMs: 1,
			toolCalls: 1,
			responseJsonBytes: 1,
			responseTextChars: 1,
			recoverableGaps: { attempted: 1, addressed: 0 },
			resourceReads: 4,
		},
	]);
	assert.deepEqual(summary.recoverableGaps, { attempted: 3, addressed: 1, successRate: 1 / 3 });
});

test("browser evaluation arguments reject missing values, partial numbers, and unknown switches", () => {
	assert.deepEqual(parseEvaluationArgs(["--quiet", "--rounds", "2", "--output", "report.json"]), {
		rounds: 2,
		output: "report.json",
		suite: "all",
		tasks: [],
		list: false,
	});
	for (const args of [
		["--rounds"],
		["--rounds", "2x"],
		["--rounds", "0"],
		["--rounds", "51"],
		["--output"],
		["--suite", "missing"],
		["--suite"],
		["--task"],
		["--url", "https://example.invalid"],
	])
		assert.throws(() => parseEvaluationArgs(args));
});

test("evaluation task selection is explicit, deterministic, and fails on typos", () => {
	const catalog = [
		{ id: "a", suite: "core" },
		{ id: "b", suite: "extended" },
		{ id: "c", suite: "extended" },
	];
	const options = parseEvaluationArgs(["--suite", "extended", "--task", "c", "--task", "b", "--task", "c", "--list"]);
	assert.equal(options.list, true);
	assert.deepEqual(
		selectEvaluationTasks(catalog, options).map((task: { id: string }) => task.id),
		["b", "c"],
	);
	assert.throws(() => selectEvaluationTasks(catalog, { suite: "core", tasks: ["b"] }), /excluded by suite/);
	assert.throws(() => selectEvaluationTasks(catalog, { suite: "all", tasks: ["typo"] }), /Unknown task/);
	assert.throws(() => selectEvaluationTasks([], { suite: "all", tasks: [] }), /No evaluation tasks/);
	assert.throws(
		() => selectEvaluationTasks([...catalog, catalog[0]], { suite: "all", tasks: [] }),
		/Duplicate task ID/,
	);
});

test("evaluation catalog covers the core, safety, frame, and recovery scenarios", async () => {
	const { evaluationTasks } = await import(new URL("../../scripts/lib/browser-eval-tasks.mjs", import.meta.url).href);
	assert.equal(selectEvaluationTasks(evaluationTasks, { suite: "core", tasks: [] }).length, 4);
	assert.equal(selectEvaluationTasks(evaluationTasks, { suite: "extended", tasks: [] }).length, 11);
	assert.equal(evaluationTasks.length, 15);
	for (const task of evaluationTasks) {
		assert.equal(typeof task.run, "function");
		assert.ok(["workflow", "safety", "recovery"].includes(task.kind));
		assert.ok(task.path && !task.path.includes("://"), "tasks must not accept an external destination");
	}
	for (const id of [
		"frame-same",
		"frame-cross",
		"frame-nested",
		"browser-reconnect",
		"multitab-ref-ownership",
		"failed-submit-no-replay",
		"spa-ref-continuity",
		"occluded-control-guard",
		"task-view-record",
		"task-view-ambiguity",
		"task-view-progressive",
	])
		assert.ok(
			evaluationTasks.some((task: { id: string }) => task.id === id),
			`missing task ${id}`,
		);
});
