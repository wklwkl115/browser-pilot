// Flat ESLint config (ESM). Type-aware linting across the two TypeScript
// environments in this repo:
//   - src/ + index.ts  → Node.js   (tsconfig.json)
//   - src/bridge/extension/       → WebWorker (tsconfig.bridge-src.json)
//
// Enabled correctness rules are blocking. The rule set stays explicit so both
// TypeScript environments share predictable lint behavior.
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
			"**/*.generated.*",
			"*.config.js",
			"*.config.mjs",
			// Auto-generated from src/bridge/protocol/native-command.schema.json — do not lint.
			"src/types/nativeProtocol.ts",
			"src/commands/nativeActionMetadata.ts",
			"src/types/nativeErrorCodes.ts",
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
	// Test sources execute in Node but import both Node and extension modules.
	{
		files: ["tests/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: "./tsconfig.tests.json",
				tsconfigRootDir: import.meta.dirname,
			},
			globals: { ...globals.node },
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
	// Blocking correctness rules.
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
			// Boundary-heavy parameter code intentionally accepts explicit unknowns.
			"@typescript-eslint/no-explicit-any": "off",
		},
	},
	// capture-src/ contains page-world JavaScript embedded in string templates and is not part of
	// the Node type graph. Syntactic rules still guard template escape correctness; type-aware rules
	// are disabled for this scope because it has no project binding.
	{
		files: ["capture-src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
		},
	},
	{
		files: ["tests/**/*.ts"],
		rules: {
			// node:test registration returns a promise-like handle that is intentionally
			// owned by the runner rather than awaited by the declaring module.
			"@typescript-eslint/no-floating-promises": "off",
			"@typescript-eslint/no-misused-promises": "off",
		},
	},
	// Refactored orchestration paths keep explicit complexity budgets so their former
	// monolithic control flow cannot silently accumulate again.
	{
		files: [
			"src/browser-runtime/abml/runtime.ts",
			"src/bridge/server/BrowserTemporalCoordinator.ts",
			"src/bridge/extension/service_worker/cdp.ts",
			"src/bridge/extension/service_worker/exec.ts",
			"src/bridge/extension/service_worker/frame.ts",
			"src/bridge/extension/service_worker/network.ts",
			"src/commands/webSecurity/browserNative/sqliProbe.ts",
			"src/commands/webSecurity/browserNative/crawl.ts",
			"src/commands/observeCommand.ts",
			"src/commands/executionEffect.ts",
			"src/commands/executionJournal.ts",
			"src/bridge/extension/service_worker/network_events.ts",
			"src/bridge/extension/service_worker/hook.ts",
			"src/commands/observe/scanRunner.ts",
			"src/commands/observe/scanSession.ts",
			"src/commands/observe/scanCache.ts",
			"src/commands/observe/scanCapture.ts",
			"src/commands/observe/scanProviders.ts",
			"src/commands/observe/scanAssembly.ts",
			"src/commands/observe/scanOutput.ts",
			"src/commands/observe/scanTabs.ts",
		],
		rules: {
			complexity: ["error", 20],
			"max-lines-per-function": ["error", 150],
		},
	},
);
