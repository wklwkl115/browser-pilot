import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { requestTool, resultEnvelope, resultText, repositoryRoot, withBrowserHarness } from "./browser-harness.mjs";
import { startEvaluationFixtures } from "./browser-eval-fixtures.mjs";
import { summarizeAttempts } from "./evaluation-metrics.mjs";
import { renderMcpToolResult, readMcpResource } from "../../src/apps/mcp/server.ts";

function fail(category, code, message) {
	throw Object.assign(new Error(message), { category, code });
}

function fixtureTarget(browser, fixture) {
	const tab = browser.status.tabs.find((item) => String(item.url ?? "").startsWith(fixture.url));
	const targetRef = tab?.targetRef ?? tab?.tabHandle;
	if (!targetRef) fail("harness", "FIXTURE_TARGET_MISSING", "Evaluation fixture has no target ref");
	return { targetRef, tab };
}

function taskContext(daemon, session, fixture, round, metrics, artifactRoot, restartBrowser) {
	let lastPresentation;
	const call = async (tool, params, expectedErrors = []) => {
		metrics.toolCalls++;
		const started = performance.now();
		const step = { tool, success: false };
		try {
			const raw = await requestTool(daemon, tool, params, 20_000, artifactRoot);
			lastPresentation = Array.isArray(raw.content)
				? renderMcpToolResult(tool, raw, artifactRoot)
				: { content: [{ type: "text", text: JSON.stringify(raw) }], isError: true };
			step.mcpResponseJsonBytes = Buffer.byteLength(JSON.stringify(lastPresentation));
			metrics.mcpResponseJsonBytes = (metrics.mcpResponseJsonBytes ?? 0) + step.mcpResponseJsonBytes;
			step.responseJsonBytes = Buffer.byteLength(JSON.stringify(raw));
			step.responseTextChars = resultText(raw).length;
			metrics.responseJsonBytes += step.responseJsonBytes;
			metrics.responseTextChars += step.responseTextChars;
			const value = resultEnvelope(raw, tool);
			const code = value.code ?? raw.details?.error?.code;
			if (value.verification) step.verification = value.verification.status;
			if (value.execution) step.execution = value.execution.status;
			if (value.business) step.business = value.business.status;
			if (raw.ok === false || raw.isError || raw.terminate || value.ok === false || code) {
				step.code = code ?? "TOOL_ERROR";
				if (!expectedErrors.includes(step.code))
					fail("tool", step.code, `${tool} returned an unexpected error`);
				step.expectedRejection = true;
			}
			step.success = true;
			return value;
		} catch (error) {
			step.code ??= error?.code ?? "TRANSPORT_ERROR";
			throw error;
		} finally {
			step.durationMs = Math.round(performance.now() - started);
			metrics.steps.push(step);
		}
	};
	return {
		fixture,
		round,
		call,
		presentation: () => lastPresentation,
		readResource: async (uri) => {
			const started = performance.now();
			const result = await readMcpResource(uri, artifactRoot);
			const bytes = Buffer.byteLength(JSON.stringify(result));
			const text = result.contents
				.filter((item) => "text" in item)
				.map((item) => item.text)
				.join("\n");
			metrics.resourceReads = (metrics.resourceReads ?? 0) + 1;
			metrics.resourceResponseJsonBytes = (metrics.resourceResponseJsonBytes ?? 0) + bytes;
			metrics.maxResourceResponseJsonBytes = Math.max(metrics.maxResourceResponseJsonBytes ?? 0, bytes);
			metrics.responseJsonBytes += bytes;
			metrics.mcpResponseJsonBytes = (metrics.mcpResponseJsonBytes ?? 0) + bytes;
			metrics.responseTextChars += text.length;
			metrics.steps.push({
				operation: "resource-read",
				resourceKind: /\/groups\/\d+$/.test(uri) ? "group" : /\/scope\/\d+$/.test(uri) ? "scope" : "index",
				success: true,
				responseJsonBytes: bytes,
				responseTextChars: text.length,
				durationMs: Math.round(performance.now() - started),
			});
			return JSON.parse(text);
		},
		navigate: (page) =>
			call("browser_tabs", {
				action: "navigate",
				targetRef: session.targetRef,
				url: `${fixture.url}${page}?run=${round}`,
				waitUntil: "load",
			}),
		restart: async () => {
			const started = performance.now();
			const step = { operation: "browser-restart", success: false };
			try {
				const previous = session.targetRef;
				const next = await restartBrowser();
				session.targetRef = fixtureTarget(next, fixture).targetRef;
				if (session.targetRef === previous)
					fail("recovery", "BROWSER_IDENTITY_REUSED", "Fresh browser reused the old target identity");
				step.reanchored = true;
				step.success = true;
			} catch (cause) {
				step.code = cause?.code ?? "BROWSER_RESTART_FAILED";
				throw Object.assign(new Error("Could not establish a fresh browser session", { cause }), {
					category: "recovery",
					code: step.code,
				});
			} finally {
				step.durationMs = Math.round(performance.now() - started);
				metrics.steps.push(step);
			}
		},
		native: (command) => call("browser_command", { targetRef: session.targetRef, command }),
		observe: (params = {}) =>
			call("browser_observe", { targetRef: session.targetRef, mode: "full", visual: "never", ...params }),
		read: async (script) =>
			(await call("browser_execute", { targetRef: session.targetRef, readOnly: true, script })).result,
		input: (ref, action, extra = {}, expect) =>
			call("browser_command", {
				command: { cmd: "input.ref", ref, action, ...extra },
				...(expect ? { expect } : {}),
			}),
		ref: (view, name) => {
			const matches =
				view.actionSpace?.items?.filter((item) => item.kind === "control" && item.name === name && item.ref) ??
				[];
			if (matches.length !== 1)
				fail("observation", "AMBIGUOUS_OR_MISSING_CONTROL", `Expected exactly one ${name} control`);
			return matches[0].ref;
		},
		verified: (value) => {
			if (value.verification?.status !== "verified")
				fail(
					"verification",
					value.verification?.status ?? "MISSING_VERIFICATION",
					"Declared assertion was not verified",
				);
		},
		assert: (condition, code, message) => {
			if (!condition) fail("assertion", code, message);
		},
	};
}

export async function runBrowserEvaluation(options, tasks) {
	const output = path.resolve(options.output);
	const artifactRoot = path.dirname(output);
	await mkdir(artifactRoot, { recursive: true });
	const attempts = [];
	const metadata = {
		schemaVersion: 2,
		fixtureVersion: 6,
		generatedAt: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		rounds: options.rounds,
		suite: options.suite,
		selectedTasks: tasks.map((task) => task.id),
		limits: [
			"Controlled local fixtures; not a live-site or LLM planning benchmark",
			"Task timing includes navigation and explicit browser-restart steps, but excludes initial browser startup",
			"Output counts are JSON UTF-8 bytes and UTF-16 text length, not model-specific tokens",
			"No automatic retries of failed writes",
		],
	};
	let harnessFailure;
	try {
		await withBrowserHarness(startEvaluationFixtures, async ({ daemon, browser, fixture, restartBrowser }) => {
			const { targetRef, tab } = fixtureTarget(browser, fixture);
			const session = { targetRef };
			Object.assign(metadata, {
				browser: path.basename(browser.executable),
				userAgent: tab.bridge?.userAgent ?? null,
				extensionBuildId: browser.status.extension?.build?.buildId ?? null,
			});
			for (let round = 1; round <= options.rounds; round++) {
				for (const task of tasks) {
					const metrics = {
						task: task.id,
						suite: task.suite,
						kind: task.kind,
						round,
						success: false,
						toolCalls: 0,
						responseJsonBytes: 0,
						responseTextChars: 0,
						steps: [],
					};
					const ctx = taskContext(daemon, session, fixture, round, metrics, artifactRoot, restartBrowser);
					const started = performance.now();
					try {
						await ctx.navigate(task.path);
						await task.run(ctx);
						metrics.success = true;
					} catch (error) {
						metrics.failure = {
							category: error?.category ?? "transport",
							code: error?.code ?? "EXECUTION_ERROR",
							message: String(error?.message ?? error).slice(0, 400),
						};
					} finally {
						metrics.durationMs = Math.round(performance.now() - started);
						attempts.push(metrics);
						console.error(
							`[browser-eval] ${task.id} round=${round} ${metrics.success ? "PASS" : "FAIL"} ${metrics.durationMs}ms`,
						);
					}
				}
			}
		});
	} catch (error) {
		harnessFailure = {
			category: "harness",
			code: error?.code ?? "HARNESS_ERROR",
			message: String(error?.message ?? error).slice(0, 400),
		};
	}
	const report = {
		...metadata,
		plannedAttempts: tasks.length * options.rounds,
		summary: summarizeAttempts(attempts),
		byTask: Object.fromEntries(
			tasks.map((task) => [task.id, summarizeAttempts(attempts.filter((attempt) => attempt.task === task.id))]),
		),
		byKind: Object.fromEntries(
			[...new Set(tasks.map((task) => task.kind))].map((kind) => [
				kind,
				summarizeAttempts(attempts.filter((attempt) => attempt.kind === kind)),
			]),
		),
		attempts,
		...(harnessFailure ? { harnessFailure } : {}),
	};
	await writeFile(output, JSON.stringify(report, null, 2) + "\n");
	console.log(
		JSON.stringify(
			{
				report: path.relative(repositoryRoot, output),
				...report.summary,
				...(harnessFailure ? { harnessFailure } : {}),
			},
			null,
			2,
		),
	);
	if (harnessFailure || report.summary.failed > 0 || attempts.length !== report.plannedAttempts) process.exitCode = 1;
	return report;
}
