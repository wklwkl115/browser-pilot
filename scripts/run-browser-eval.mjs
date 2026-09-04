import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { invoke, resultEnvelope, resultText, repositoryRoot, withBrowserHarness } from "./lib/browser-harness.mjs";
import { startEvaluationFixtures } from "./lib/browser-eval-fixtures.mjs";
import { evaluationTasks } from "./lib/browser-eval-tasks.mjs";
import { parseEvaluationArgs, summarizeAttempts } from "./lib/evaluation-metrics.mjs";

const options = parseEvaluationArgs(process.argv.slice(2));
const output = path.resolve(options.output);
const artifactRoot = path.dirname(output);
await mkdir(artifactRoot, { recursive: true });
const attempts = [];
const metadata = {
	schemaVersion: 1,
	fixtureVersion: 1,
	generatedAt: new Date().toISOString(),
	node: process.version,
	platform: process.platform,
	arch: process.arch,
	rounds: options.rounds,
	limits: [
		"Controlled local fixtures; not a live-site or LLM planning benchmark",
		"Latency includes navigation and all task tool calls, but excludes browser startup",
		"Output counts are JSON UTF-8 bytes and text characters, not model-specific tokens",
		"No automatic retries of failed writes",
	],
};

function fail(category, code, message) {
	throw Object.assign(new Error(message), { category, code });
}

function taskContext(daemon, targetRef, fixture, round, metrics) {
	const call = async (tool, params, allowError = false) => {
		metrics.toolCalls++;
		const raw = await invoke(daemon, tool, params, 20_000, artifactRoot);
		metrics.responseJsonBytes += Buffer.byteLength(JSON.stringify(raw));
		metrics.responseTextChars += resultText(raw).length;
		const value = resultEnvelope(raw, tool);
		if (!allowError && (raw.isError || value.ok === false || value.code))
			fail("tool", value.code ?? "TOOL_ERROR", `${tool} returned an error`);
		return value;
	};
	return {
		fixture,
		round,
		call,
		observe: () => call("browser_observe", { targetRef, mode: "full", visual: "never" }),
		read: async (script) => (await call("browser_execute", { targetRef, readOnly: true, script })).result,
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
					"Business postcondition was not verified",
				);
		},
		assert: (condition, code, message) => {
			if (!condition) fail("assertion", code, message);
		},
	};
}

let startupFailure;
try {
	await withBrowserHarness(startEvaluationFixtures, async ({ daemon, browser, fixture }) => {
		const tab = browser.status.tabs.find((item) => String(item.url ?? "").startsWith(fixture.url));
		const targetRef = tab?.targetRef ?? tab?.tabHandle;
		if (!targetRef) throw new Error("Evaluation fixture has no target ref");
		metadata.browser = path.basename(browser.executable);
		metadata.userAgent = tab.bridge?.userAgent ?? null;
		metadata.extensionBuildId = browser.status.extension?.build?.buildId ?? null;
		for (let round = 1; round <= options.rounds; round++) {
			for (const task of evaluationTasks) {
				const metrics = {
					task: task.id,
					kind: task.kind,
					round,
					success: false,
					toolCalls: 0,
					responseJsonBytes: 0,
					responseTextChars: 0,
				};
				const ctx = taskContext(daemon, targetRef, fixture, round, metrics);
				const started = performance.now();
				try {
					await ctx.call("browser_tabs", {
						action: "navigate",
						targetRef,
						url: `${fixture.url}${task.path}?run=${round}`,
						waitUntil: "load",
					});
					await task.run(ctx);
					metrics.success = true;
				} catch (error) {
					metrics.failure = {
						category: error.category ?? "transport",
						code: error.code ?? "EXECUTION_ERROR",
						message: String(error.message).slice(0, 400),
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
	startupFailure = {
		category: "harness",
		code: error.code ?? "HARNESS_ERROR",
		message: String(error.message).slice(0, 400),
	};
}
const report = {
	...metadata,
	summary: summarizeAttempts(attempts),
	byTask: Object.fromEntries(
		evaluationTasks.map((task) => [
			task.id,
			summarizeAttempts(attempts.filter((attempt) => attempt.task === task.id)),
		]),
	),
	attempts,
	...(startupFailure ? { harnessFailure: startupFailure } : {}),
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
	JSON.stringify(
		{
			report: path.relative(repositoryRoot, output),
			...report.summary,
			...(startupFailure ? { harnessFailure: startupFailure } : {}),
		},
		null,
		2,
	),
);
if (startupFailure || report.summary.failed > 0 || attempts.length !== evaluationTasks.length * options.rounds)
	process.exitCode = 1;
