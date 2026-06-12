#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
	return "usage: node evals/browser-workflows/distill-usage-log.mjs <usage.jsonl...> [--stage stage.json ...] [--out report.json]";
}

function parseArgs(argv) {
	const logs = [];
	const stages = [];
	let out;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--stage") stages.push(argv[++i]);
		else if (arg === "--out") out = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			console.log(usage());
			process.exit(0);
		} else if (arg?.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
		else logs.push(arg);
	}
	if (!logs.length) throw new Error(`missing usage log\n${usage()}`);
	return { logs, stages, out };
}

function percentile(values, p) {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function inc(record, key, by = 1) {
	record[key] = (record[key] || 0) + by;
}

function stableParamsKey(record) {
	return JSON.stringify({ tool: record.tool || record.method || "unknown", args: record.args ?? null, cli: record.cli ?? null });
}

async function readJson(pathname) {
	return JSON.parse(await readFile(pathname, "utf8"));
}

async function readJsonl(pathname) {
	const text = await readFile(pathname, "utf8").catch((error) => {
		if (error?.code === "ENOENT") return "";
		throw error;
	});
	return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
		try {
			return JSON.parse(line);
		} catch (error) {
			throw new Error(`${pathname}:${index + 1}: invalid JSONL: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

export async function distillUsageLogs(options) {
	const stageByRunId = new Map();
	for (const stagePath of options.stages || []) {
		const stage = await readJson(stagePath);
		if (stage?.runId) stageByRunId.set(String(stage.runId), { path: stagePath, startUrl: stage.startUrl, currentUrl: stage.currentUrl, fixtures: stage.fixtures, taskId: stage.taskId, agent: stage.agent, goal: stage.goal });
	}
	const buckets = new Map();
	for (const logPath of options.logs) {
		for (const record of await readJsonl(logPath)) {
			const runId = typeof record.runId === "string" && record.runId ? record.runId : "unattributed";
			if (!buckets.has(runId)) buckets.set(runId, { runId, logs: new Set(), records: [] });
			const bucket = buckets.get(runId);
			bucket.logs.add(logPath);
			bucket.records.push(record);
		}
	}
	const runs = [];
	for (const bucket of buckets.values()) {
		const callsByTool = {};
		const errorCodesByTool = {};
		const routing = { natural: 0, advancedCompatibility: 0, standard: 0, other: 0 };
		const durations = [];
		const repeatKeys = new Map();
		for (const record of bucket.records) {
			const tool = String(record.tool || record.method || "unknown");
			inc(callsByTool, tool);
			if (typeof record.ms === "number") durations.push(record.ms);
			const route = String(record.cli?.routing || "");
			if (route === "natural") routing.natural += 1;
			else if (route === "advancedCompatibility") routing.advancedCompatibility += 1;
			else if (route === "standard") routing.standard += 1;
			else if (route) routing.other += 1;
			const code = typeof record.details?.code === "string" ? record.details.code : typeof record.code === "string" ? record.code : undefined;
			if (record.result === "error" && code) {
				if (!errorCodesByTool[tool]) errorCodesByTool[tool] = {};
				inc(errorCodesByTool[tool], code);
			}
			const key = stableParamsKey(record);
			const repeat = repeatKeys.get(key) || { tool, count: 0, args: record.args, cli: record.cli };
			repeat.count += 1;
			repeatKeys.set(key, repeat);
		}
		runs.push({
			runId: bucket.runId,
			attributed: bucket.runId !== "unattributed",
			stage: stageByRunId.get(bucket.runId),
			logs: [...bucket.logs].sort(),
			totalCalls: bucket.records.length,
			callsByTool,
			errorCodesByTool,
			routing,
			durationMs: { p50: percentile(durations, 50), p95: percentile(durations, 95) },
			repeatedCalls: [...repeatKeys.values()].filter((item) => item.count > 1).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)).slice(0, 20),
		});
	}
	runs.sort((a, b) => a.runId.localeCompare(b.runId));
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		runCount: runs.length,
		totalCalls: runs.reduce((sum, run) => sum + run.totalCalls, 0),
		runs,
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const report = await distillUsageLogs(args);
		const text = `${JSON.stringify(report, null, 2)}\n`;
		if (args.out) await writeFile(args.out, text, "utf8");
		else process.stdout.write(text);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
}
