// Flat ESLint config (ESM). Type-aware linting across the two TypeScript
// environments in this repo:
//   - src/ + index.ts  → Node.js   (tsconfig.json)
//   - src/bridge/extension/       → WebWorker (tsconfig.bridge-src.json)
//
// Ratcheted posture: the historical warning backlog is burned down, and the
// enabled debt rules now block regressions. Broader type-checked families and
// @typescript-eslint/no-explicit-any remain outside this rule set.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
	{
		// Never lint build output, generated protocol files, or non-source trees.
		ignores: [
			"dist/**",
			// Packaged extension output dir (compiled dist + generated config.js +
			// static popup/assets). Editable source lives in src/bridge/extension/.
			"bridge/browser_pilot_bridge/**",
			"node_modules/**",
			// Runtime artifact/output dir — captured third-party web assets, not source.
			".browser-pilot/**",
			"coverage/**",
			"**/*.min.js",
			"docs/**",
			"tests/**",
			"scripts/**",
			"**/*.generated.*",
			"*.config.js",
			"*.config.mjs",
			// Auto-generated from src/bridge/protocol/native-command.schema.json — do not lint.
			"src/bridge/protocol/nativeProtocol.ts",
			"src/bridge/protocol/nativeActionMetadata.ts",
			"src/bridge/protocol/nativeErrorCodes.ts",
			"src/bridge/extension/service_worker/protocol.ts",
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
		files: ["src/bridge/extension/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.bridge-src.json",
				tsconfigRootDir: import.meta.dirname,
			},
			globals: { ...globals.worker, chrome: "readonly" },
		},
	},
	// Page scripts run injected in the page DOM context, not the worker.
	{
		files: ["src/bridge/extension/page_scripts/**/*.ts"],
		languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
	},
	// Plain JS/MJS sources (OAST worker, hand-authored extension files) — no
	// type info available; just give them the right ambient globals.
	{
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: { globals: { ...globals.node, ...globals.browser, chrome: "readonly" } },
	},
	// ─── Ratcheted debt rules: blocking. ───
	// These are the historical backlog families that have been cleared and now
	// run as errors. Broader strict-type rules remain intentionally out of scope.
	//
	// Core ESLint rules (no type info needed) — apply to all source.
	{
		rules: {
			// no-empty ignores blocks containing a comment, so the existing
			// `/* best-effort ... */` catches already pass — only truly-bare
			// `catch (_) {}` get flagged. (Matches the silent-catch hardening style.)
			"no-empty": ["error", { allowEmptyCatch: false }],
			"no-fallthrough": "error",
			"no-sparse-arrays": "error",
			"no-control-regex": "error",
			"no-useless-escape": "error",
			"no-useless-assignment": "error",
			"preserve-caught-error": "error",
			"prefer-const": "error",
			"prefer-rest-params": "error",
		},
	},
	// typescript-eslint rules — scoped to .ts (all of which are project-bound above,
	// so the type-aware rules have parserServices available).
	{
		files: ["**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
			],
			"@typescript-eslint/no-unused-expressions": "error",
			"@typescript-eslint/no-unsafe-function-type": "error",
			// Async-safety class — highest-value, likely real bugs. Type-aware.
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			// Deferred for the first pass (noisy on the unknown-heavy param code).
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	// capture-src/ is page-world string-template source (MAIN-world JS embedded in string
	// constants, deliberately NOT in the Node type graph — see docs/capture-core-plan.md as-built
	// note + the "page logic is untyped strings" residual debt). Syntactic rules still apply —
	// crucially no-useless-escape, which guards the template-literal escape-collapse bug class.
	// The two type-aware rules cannot run without a project binding; disable them here. When the
	// esbuild-migration trigger fires, capture-src joins a typed project and these come back.
	{
		files: ["capture-src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
		},
	},
);
