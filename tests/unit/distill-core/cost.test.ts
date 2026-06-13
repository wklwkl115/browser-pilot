import test from "node:test";
import assert from "node:assert/strict";
import { tokenEstimate } from "../../../src/distill-core/cost.ts";
import { compareMicroBench, microBenchSink } from "../helpers/microBench.ts";

function tokenEstimateReference(text: string): number {
	let tokens = 0;
	for (const ch of text) {
		const codePoint = ch.codePointAt(0) ?? 0;
		tokens += codePoint > 0x2e7f ? 0.6 : codePoint < 0x80 ? 0.25 : 0.4;
	}
	return Math.ceil(tokens);
}

function tokenEstimateMutant(text: string): number {
	let tokens = 0;
	for (const ch of text) {
		const codePoint = ch.codePointAt(0) ?? 0;
		tokens += codePoint > 0x2e7f ? 0.5 : codePoint < 0x80 ? 0.25 : 0.4;
	}
	return Math.ceil(tokens);
}

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

function randomCorpus(seed: number, count: number): string[] {
	const next = lcg(seed);
	const tokens = [
		"",
		"a",
		"go",
		"页面",
		"é",
		"\u00A0",
		"\uD83D\uDE00",
		"\uD800",
		"\uDC00",
		"\uD800\uD800",
		"\uD800x",
		"x\uDC00",
		"שלום",
		"مرحبا",
		"abc123",
	];
	const out: string[] = [];
	for (let i = 0; i < count; i += 1) {
		let text = "";
		const parts = (next() % 8) + 1;
		for (let j = 0; j < parts; j += 1) text += tokens[next() % tokens.length];
		out.push(text);
	}
	return out;
}

test("tokenEstimate matches the current code-point weighting across fixed and randomized inputs", () => {
	const fixed = [
		"",
		"go",
		"页面",
		"a😀b",
		"\uD83D\uDE00",
		"\uD800",
		"\uD800x",
		"\uD800\uD800",
		"\uDC00",
		"\uD83D",
		"hello世界😀",
	];
	const corpus = [...fixed, ...randomCorpus(0xC0D3, 256)];
	const reference = corpus.map((text) => tokenEstimateReference(text));
	const mutant = corpus.map((text) => tokenEstimateMutant(text));
	assert.notDeepEqual(mutant, reference);
	assert.deepEqual(corpus.map((text) => tokenEstimate(text)), reference);
});

test("tokenEstimate micro-bench stays on the shared helper", () => {
	const corpus = randomCorpus(0xC057, 128);
	const charsPerIteration = corpus.reduce((sum, text) => sum + text.length, 0);
	const bench = compareMicroBench({
		reference: () => {
			let total = 0;
			for (const text of corpus) total += tokenEstimateReference(text);
			return total;
		},
		candidate: () => {
			let total = 0;
			for (const text of corpus) total += tokenEstimate(text);
			return total;
		},
		iterations: 400,
		warmupSamples: 2,
		samples: 7,
	});
	assert.ok(Number.isFinite(bench.speedup));
	assert.ok(Number.isFinite(bench.referenceNsPerOp));
	assert.ok(Number.isFinite(bench.candidateNsPerOp));
	assert.ok(microBenchSink() >= 0);
	const candidateNsPerChar = bench.candidateNsPerOp / Math.max(1, charsPerIteration);
	const referenceNsPerChar = bench.referenceNsPerOp / Math.max(1, charsPerIteration);
	console.log(`tokenEstimate microbench speedup=${bench.speedup.toFixed(2)}x candidate_ns_per_char=${candidateNsPerChar.toFixed(3)} reference_ns_per_char=${referenceNsPerChar.toFixed(3)}`);
});
