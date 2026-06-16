export const sourceRules = [
	{
		key: "web-security-baseline-star-replay-diff",
		description: "web security baseline facade star-exporting the replay diff kernel instead of owning an explicit command-facing surface",
		path: "src/commands/webSecurity/shared/baseline.ts",
		to: "src/kernels/security/replayDiff.ts",
		pattern: /\bexport\s+\*\s+from\s+["']\.\.\/\.\.\/\.\.\/kernels\/security\/replayDiff\.js["']/u,
	},
	{
		key: "memory-routing-star-kernel-export",
		description: "memory routing facade star-exporting the memory routing kernel instead of owning an explicit memory-facing surface",
		path: "src/memory/routing.ts",
		to: "src/kernels/memory/routing.ts",
		pattern: /\bexport\s+\*\s+from\s+["']\.\.\/kernels\/memory\/routing\.js["']/u,
	},
	{
		key: "commands-memory-salience-star-kernel-export",
		description: "memory command salience facade star-exporting the memory salience kernel instead of owning an explicit command-facing surface",
		path: "src/commands/memory/salience.ts",
		to: "src/kernels/memory/salience.ts",
		pattern: /\bexport\s+\*\s+from\s+["']\.\.\/\.\.\/kernels\/memory\/salience\.js["']/u,
	},
];
