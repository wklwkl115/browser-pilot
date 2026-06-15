import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TemporalFrontierNext, TemporalProfileSample, TemporalReason, TemporalVerdictStatus } from "../../kernels/temporal/types.js";

type NumericMetricSummary = {
	samples: number;
	min: number;
	median: number;
	p95: number;
	max: number;
};

export type TemporalProfileSummary = {
	schemaVersion: 1;
	generatedAt: string;
	runId: string;
	runnerSummaryPath?: string;
	resultDir?: string;
	sampleCount: number;
	tools: Record<string, number>;
	commands: Record<string, number>;
	verdicts: Partial<Record<TemporalVerdictStatus, number>>;
	reasons: Partial<Record<TemporalReason, number>>;
	recovery: Partial<Record<TemporalFrontierNext, number>>;
	historyLostCount: number;
	queueDelayMs?: NumericMetricSummary;
	elapsedMs?: NumericMetricSummary;
	waitAttempts?: NumericMetricSummary;
	workerRestarts?: NumericMetricSummary;
};

export type TemporalProfileArtifactWrite = {
	cwd?: string;
	runId: string;
	samples: TemporalProfileSample[];
	evalRunDir?: string;
	runnerSummaryPath?: string;
};

export type TemporalProfileArtifactPaths = {
	canonicalSummaryPath: string;
	runSummaryPath: string;
	runSamplesPath: string;
	evalRunSummaryPath?: string;
};

function artifactRoot(cwd = process.cwd()): string {
	return path.resolve(cwd, ".browser-pilot", "artifacts");
}

export function temporalProfileSummaryPath(cwd?: string): string {
	return path.join(artifactRoot(cwd), "temporal-profile-summary.json");
}

export function temporalProfileRunDir(cwd: string | undefined, runId: string): string {
	return path.join(artifactRoot(cwd), "temporal-profile", normalizeTemporalProfileRunId(runId));
}

export function normalizeTemporalProfileRunId(runId: string): string {
	return runId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "runtime";
}

function pathRef(cwd: string | undefined, absPath: string): string {
	return path.relative(path.resolve(cwd || process.cwd()), absPath).replace(/\\/g, "/");
}

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
	const out: Partial<Record<T, number>> = {};
	for (const value of values) out[value] = (out[value] || 0) + 1;
	return out;
}

function countStrings(values: Array<string | undefined>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const value of values) {
		if (!value) continue;
		out[value] = (out[value] || 0) + 1;
	}
	return out;
}

function numericMetricSummary(values: Array<number | undefined>): NumericMetricSummary | undefined {
	const sorted = values.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
	if (!sorted.length) return undefined;
	const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	return { samples: sorted.length, min: sorted[0], median, p95: percentile(0.95), max: sorted[sorted.length - 1] };
}

export function summarizeTemporalProfileSamples(samples: TemporalProfileSample[], input: { cwd?: string; runId: string; evalRunDir?: string; runnerSummaryPath?: string }): TemporalProfileSummary {
	const reasons = samples.flatMap((sample) => sample.reasons || []);
	const summary: TemporalProfileSummary = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		runId: normalizeTemporalProfileRunId(input.runId),
		...(input.runnerSummaryPath ? { runnerSummaryPath: pathRef(input.cwd, input.runnerSummaryPath) } : {}),
		...(input.evalRunDir ? { resultDir: pathRef(input.cwd, input.evalRunDir) } : {}),
		sampleCount: samples.length,
		tools: countStrings(samples.map((sample) => sample.tool)),
		commands: countStrings(samples.map((sample) => sample.command)),
		verdicts: countBy(samples.map((sample) => sample.verdict).filter((value): value is TemporalVerdictStatus => !!value)),
		reasons: countBy(reasons),
		recovery: countBy(samples.map((sample) => sample.recovery).filter((value): value is TemporalFrontierNext => !!value)),
		historyLostCount: samples.filter((sample) => sample.historyLost === true).length,
		...(numericMetricSummary(samples.map((sample) => sample.queueDelayMs)) ? { queueDelayMs: numericMetricSummary(samples.map((sample) => sample.queueDelayMs)) } : {}),
		...(numericMetricSummary(samples.map((sample) => sample.elapsedMs)) ? { elapsedMs: numericMetricSummary(samples.map((sample) => sample.elapsedMs)) } : {}),
		...(numericMetricSummary(samples.map((sample) => sample.waitAttempts)) ? { waitAttempts: numericMetricSummary(samples.map((sample) => sample.waitAttempts)) } : {}),
		...(numericMetricSummary(samples.map((sample) => sample.workerRestarts)) ? { workerRestarts: numericMetricSummary(samples.map((sample) => sample.workerRestarts)) } : {}),
	};
	return summary;
}

export async function writeTemporalProfileArtifacts(input: TemporalProfileArtifactWrite): Promise<TemporalProfileArtifactPaths> {
	const cwd = input.cwd;
	const runDir = temporalProfileRunDir(cwd, input.runId);
	const canonicalSummaryPath = temporalProfileSummaryPath(cwd);
	const runSummaryPath = path.join(runDir, "temporal-profile-summary.json");
	const runSamplesPath = path.join(runDir, "temporal-profile-samples.jsonl");
	const summary = summarizeTemporalProfileSamples(input.samples, input);
	const lines = input.samples.map((sample) => JSON.stringify(sample)).join("\n");
	await mkdir(runDir, { recursive: true });
	await mkdir(path.dirname(canonicalSummaryPath), { recursive: true });
	await writeFile(runSamplesPath, lines ? `${lines}\n` : "", "utf8");
	await writeFile(runSummaryPath, JSON.stringify(summary, null, 2), "utf8");
	await writeFile(canonicalSummaryPath, JSON.stringify(summary, null, 2), "utf8");
	let evalRunSummaryPath: string | undefined;
	if (input.evalRunDir) {
		evalRunSummaryPath = path.join(input.evalRunDir, "temporal-profile-summary.json");
		await mkdir(input.evalRunDir, { recursive: true });
		await writeFile(evalRunSummaryPath, JSON.stringify(summary, null, 2), "utf8");
	}
	return { canonicalSummaryPath, runSummaryPath, runSamplesPath, ...(evalRunSummaryPath ? { evalRunSummaryPath } : {}) };
}
