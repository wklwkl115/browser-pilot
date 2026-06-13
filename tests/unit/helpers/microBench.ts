import { performance } from "node:perf_hooks";

type BenchFn = () => unknown;

export type MicroBenchResult = {
	referenceMedianMs: number;
	candidateMedianMs: number;
	speedup: number;
	referenceNsPerOp: number;
	candidateNsPerOp: number;
};

let sink = 0;

function consume(value: unknown): void {
	if (typeof value === "number") sink += value;
	else if (typeof value === "string") sink += value.length;
	else if (value) sink += 1;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measure(fn: BenchFn, iterations: number): number {
	const startedAt = performance.now();
	for (let i = 0; i < iterations; i += 1) consume(fn());
	return performance.now() - startedAt;
}

export function compareMicroBench(options: {
	reference: BenchFn;
	candidate: BenchFn;
	iterations?: number;
	warmupSamples?: number;
	samples?: number;
}): MicroBenchResult {
	const iterations = Math.max(1, Math.floor(options.iterations ?? 1_000));
	const warmupSamples = Math.max(0, Math.floor(options.warmupSamples ?? 2));
	const samples = Math.max(1, Math.floor(options.samples ?? 7));
	for (let i = 0; i < warmupSamples; i += 1) {
		measure(options.reference, iterations);
		measure(options.candidate, iterations);
	}
	const referenceRuns: number[] = [];
	const candidateRuns: number[] = [];
	for (let i = 0; i < samples; i += 1) {
		referenceRuns.push(measure(options.reference, iterations));
		candidateRuns.push(measure(options.candidate, iterations));
	}
	const referenceMedianMs = median(referenceRuns);
	const candidateMedianMs = median(candidateRuns);
	const referenceNsPerOp = (referenceMedianMs * 1_000_000) / iterations;
	const candidateNsPerOp = (candidateMedianMs * 1_000_000) / iterations;
	return {
		referenceMedianMs,
		candidateMedianMs,
		speedup: candidateMedianMs === 0 ? Number.POSITIVE_INFINITY : referenceMedianMs / candidateMedianMs,
		referenceNsPerOp,
		candidateNsPerOp,
	};
}

export function microBenchSink(): number {
	return sink;
}
