// Flat ESLint config (ESM). Type-aware linting across the two TypeScript
// environments in this repo:
//   - src/ + index.ts  → Node.js   (tsconfig.json)
//   - bridge_src/       → WebWorker (tsconfig.bridge-src.json)
//
// First-rollout posture: WARN-ONLY and focused on the correctness debt class
// the project has been hardening by hand (empty catches, floating promises,
// unused bindings). The noisier type-checked families (no-unsafe-*) are left
// off initially and can be ratcheted on once the warn backlog is burned down.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
	{
		// Never lint build output, generated protocol files, or non-source trees.
		ignores: [
			"dist/**",
			// Packaged extension output dir (compiled dist + generated config.js +
			// static popup/assets). Editable source lives in bridge_src/.
			"bridge/pi_browser_bridge/**",
			"node_modules/**",
			// Runtime artifact/output dir — captured third-party web assets, not source.
			".pi/**",
			"coverage/**",
			"**/*.min.js",
			"docs/**",
			"evals/**",
			"tests/**",
			"scripts/**",
			"**/*.generated.*",
			"*.config.js",
			"*.config.mjs",
			// Auto-generated from bridge/native_command_schema.json — do not lint.
			"src/protocol/nativeProtocol.ts",
			"src/protocol/nativeActionMetadata.ts",
			"src/protocol/nativeErrorCodes.ts",
			"bridge_src/service_worker/protocol.ts",
		],
	},
	js.configs.recommended,
	// Syntactic TS rules only (no type info required → low noise).
	...tseslint.configs.recommended,
	// Node source — type-aware parser bound to the Node tsconfig.
	{
		files: ["src/**/*.ts", "index.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
			globals: { ...globals.node },
		},
	},
	// Bridge source — type-aware parser bound to the WebWorker tsconfig.
	{
		files: ["bridge_src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.bridge-src.json",
				tsconfigRootDir: import.meta.dirname,
			},
			globals: { ...globals.worker, chrome: "readonly" },
		},
	},
	// MCP adapter sources — type-aware via the build tsconfig (which includes mcp/).
	{
		files: ["mcp/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.build.json",
				tsconfigRootDir: import.meta.dirname,
			},
			globals: { ...globals.node },
		},
	},
	// Page scripts run injected in the page DOM context, not the worker.
	{
		files: ["bridge_src/page_scripts/**/*.ts"],
		languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
	},
	// Plain JS/MJS sources (OAST worker, hand-authored extension files) — no
	// type info available; just give them the right ambient globals.
	{
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: "readonly" } },
	},
	// ─── Baseline backlog: WARN-only, non-blocking. ───
	// Every rule that currently fires is set to "warn" so `npm run lint` exits 0 —
	// the baseline is established without breaking anything. As each category is
	// burned down, ratchet it to "error" so future regressions block.
	//
	// Core ESLint rules (no type info needed) — apply to all source.
	{
		rules: {
			// no-empty ignores blocks containing a comment, so the existing
			// `/* best-effort ... */` catches already pass — only truly-bare
			// `catch (_) {}` get flagged. (Matches the silent-catch hardening style.)
			"no-empty": ["warn", { allowEmptyCatch: false }],
			"no-fallthrough": "warn",
			"no-sparse-arrays": "warn",
			"no-control-regex": "warn",
			"no-useless-escape": "warn",
			"no-useless-assignment": "warn",
			"preserve-caught-error": "warn",
			"prefer-const": "warn",
			"prefer-rest-params": "warn",
		},
	},
	// typescript-eslint rules — scoped to .ts (all of which are project-bound above,
	// so the type-aware rules have parserServices available).
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"warn",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
			],
			"@typescript-eslint/no-unused-expressions": "warn",
			"@typescript-eslint/no-unsafe-function-type": "warn",
			// Async-safety class — highest-value, likely real bugs. Type-aware.
			"@typescript-eslint/no-floating-promises": "warn",
			"@typescript-eslint/no-misused-promises": "warn",
			// Deferred for the first pass (noisy on the unknown-heavy param code).
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
);
