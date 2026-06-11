export const PURE_RUNTIME_READ_PATTERNS = [
	{ pattern: /\bDate\.now\s*\(/, label: "Date.now(" },
	{ pattern: /\bMath\.random\s*\(/, label: "Math.random(" },
	{ pattern: /\bnew\s+Date\s*\(/, label: "new Date(" },
	{ pattern: /\bperformance\.now\s*\(/, label: "performance.now(" },
	{ pattern: /\.localeCompare\s*\(/, label: "localeCompare(" },
	{ pattern: /\.toLocale[A-Za-z]*\s*\(/, label: "toLocale*(" },
	{ pattern: /\bprocess\.env\b/, label: "process.env" },
];

export function stripStringLiterals(text) {
	return text
		.replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/`(?:\\.|[^`\\])*`/g, "``");
}

export function forbiddenRuntimeReadLabels(text) {
	const stripped = stripStringLiterals(text);
	return PURE_RUNTIME_READ_PATTERNS
		.filter(({ pattern }) => pattern.test(stripped))
		.map(({ label }) => label);
}
