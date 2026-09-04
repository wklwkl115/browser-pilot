export function parseEvaluationArgs(args) {
	const options = { rounds: 3, output: ".cache/browser-eval/report.json" };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--quiet") continue;
		if (arg === "--rounds") {
			const value = args[++index];
			if (!/^[1-9]\d*$/.test(value ?? "") || Number(value) > 50)
				throw new Error("--rounds must be an integer from 1 to 50");
			options.rounds = Number(value);
		} else if (arg === "--output") {
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new Error("--output requires a file path");
			options.output = value;
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
	for (const attempt of attempts) {
		if (attempt.success) continue;
		const key = `${attempt.failure?.category ?? "unknown"}:${attempt.failure?.code ?? "UNKNOWN"}`;
		errors[key] = (errors[key] ?? 0) + 1;
	}
	return {
		attempted: attempts.length,
		passed,
		failed: attempts.length - passed,
		successRate: attempts.length ? passed / attempts.length : null,
		latencyMs: distribution(attempts.map((attempt) => attempt.durationMs)),
		successLatencyMs: distribution(
			attempts.filter((attempt) => attempt.success).map((attempt) => attempt.durationMs),
		),
		toolCalls: attempts.reduce((total, attempt) => total + attempt.toolCalls, 0),
		responseJsonBytes: attempts.reduce((total, attempt) => total + attempt.responseJsonBytes, 0),
		responseTextChars: attempts.reduce((total, attempt) => total + attempt.responseTextChars, 0),
		errors,
	};
}
