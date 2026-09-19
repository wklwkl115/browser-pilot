export function parseEvaluationArgs(args) {
	const options = { rounds: 3, output: ".cache/browser-eval/report.json", suite: "all", tasks: [], list: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--quiet") continue;
		if (arg === "--list") {
			options.list = true;
			continue;
		}
		if (arg === "--rounds") {
			const value = args[++index];
			if (!/^[1-9]\d*$/.test(value ?? "") || Number(value) > 50)
				throw new Error("--rounds must be an integer from 1 to 50");
			options.rounds = Number(value);
		} else if (arg === "--output") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
			options.output = value;
		} else if (arg === "--suite") {
			const value = args[++index];
			if (!["core", "extended", "all"].includes(value)) throw new Error("--suite must be core, extended, or all");
			options.suite = value;
		} else if (arg === "--task") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("--task requires a task ID");
			options.tasks.push(value);
		} else throw new Error(`Unknown evaluation argument: ${arg}`);
	}
	return options;
}

function distribution(values) {
	if (!values.length) return { count: 0, p50: null, p95: null, max: null };
	const sorted = [...values].sort((a, b) => a - b);
	const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
	return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

export function summarizeAttempts(attempts) {
	const passed = attempts.filter((attempt) => attempt.success).length;
	const errors = {};
	const comparisons = attempts
		.filter((attempt) => attempt.equivalentNeedCosts)
		.map((attempt) => attempt.equivalentNeedCosts);
	const needPaths = comparisons.flatMap((comparison) =>
		["page", "wholeGroup", "progressivePacket"].map((key) => comparison.paths?.[key]),
	);
	const recoverable = attempts.reduce(
		(total, attempt) => ({
			attempted: total.attempted + (attempt.recoverableGaps?.attempted ?? 0),
			addressed: total.addressed + (attempt.recoverableGaps?.addressed ?? 0),
		}),
		{ attempted: 0, addressed: 0 },
	);
	for (const attempt of attempts) {
		if (attempt.success) continue;
		const key = `${attempt.failure?.category ?? "unknown"}:${attempt.failure?.code ?? "UNKNOWN"}`;
		errors[key] = (errors[key] ?? 0) + 1;
	}
	return {
		...(comparisons.length
			? {
					equivalentNeeds: {
						comparisons: comparisons.length,
						comparableComparisons: comparisons.filter((comparison) =>
							["page", "wholeGroup", "progressivePacket"].every(
								(key) => comparison.paths?.[key]?.status === "satisfied",
							),
						).length,
						satisfiedPaths: needPaths.filter((entry) => entry?.status === "satisfied").length,
						unsatisfiedPaths: needPaths.filter((entry) => entry?.status === "unsatisfied").length,
						budgetExhaustedPaths: needPaths.filter((entry) => entry?.status === "budget-exhausted").length,
						missingPaths: needPaths.filter((entry) => !entry).length,
					},
				}
			: {}),
		recoverableGaps: {
			...recoverable,
			successRate: recoverable.attempted ? recoverable.addressed / recoverable.attempted : null,
		},
		attempted: attempts.length,
		passed,
		failed: attempts.length - passed,
		successRate: attempts.length ? passed / attempts.length : null,
		latencyMs: distribution(attempts.map((attempt) => attempt.durationMs)),
		successLatencyMs: distribution(
			attempts.filter((attempt) => attempt.success).map((attempt) => attempt.durationMs),
		),
		toolCalls: attempts.reduce((total, attempt) => total + attempt.toolCalls, 0),
		resourceReads: attempts.reduce((total, attempt) => total + (attempt.resourceReads ?? 0), 0),
		resourceResponseJsonBytes: attempts.reduce(
			(total, attempt) => total + (attempt.resourceResponseJsonBytes ?? 0),
			0,
		),
		maxResourceResponseJsonBytes: Math.max(
			0,
			...attempts.map((attempt) => attempt.maxResourceResponseJsonBytes ?? 0),
		),
		mcpResponseJsonBytes: attempts.every((attempt) => typeof attempt.mcpResponseJsonBytes === "number")
			? attempts.reduce((total, attempt) => total + attempt.mcpResponseJsonBytes, 0)
			: null,
		responseJsonBytes: attempts.reduce((total, attempt) => total + attempt.responseJsonBytes, 0),
		responseTextChars: attempts.reduce((total, attempt) => total + attempt.responseTextChars, 0),
		errors,
	};
}

export function selectEvaluationTasks(tasks, options) {
	const ids = new Set();
	for (const task of tasks) {
		if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
		ids.add(task.id);
	}
	const selected = tasks.filter((task) => options.suite === "all" || task.suite === options.suite);
	for (const id of options.tasks) {
		if (!selected.some((task) => task.id === id)) throw new Error(`Unknown task or excluded by suite: ${id}`);
	}
	const result = options.tasks.length ? selected.filter((task) => options.tasks.includes(task.id)) : selected;
	if (!result.length) throw new Error("No evaluation tasks selected");
	return result;
}
