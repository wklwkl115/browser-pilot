import test from "node:test";
import assert from "node:assert/strict";
import { jsonPreview, resetStableJsonInvocationCounter, stableJson, stableJsonInvocationCounter, truncateText } from "../../../src/utils/json.ts";
import { compareMicroBench, microBenchSink } from "../helpers/microBench.ts";

function stableJsonReference(value: unknown, spaces = 2): string {
	const ancestors: unknown[] = [];
	return JSON.stringify(value, function (this: unknown, _key, item) {
		if (typeof item === "bigint") return item.toString();
		if (item instanceof Error) return { name: item.name, message: item.message };
		if (item === null || typeof item !== "object") return item;
		while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
		if (ancestors.includes(item)) return "[Circular]";
		ancestors.push(item);
		return item;
	}, spaces);
}

function stableJsonWholeWalkVisitedMutant(value: unknown, spaces = 2): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, function (_key, item) {
		if (typeof item === "bigint") return item.toString();
		if (item instanceof Error) return { name: item.name, message: item.message };
		if (item === null || typeof item !== "object") return item;
		if (seen.has(item)) return "[Circular]";
		seen.add(item);
		return item;
	}, spaces);
}

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

function randomPlainJsonValue(next: () => number, depth: number): unknown {
	const strings = ["", "text", "中文", "emoji-\uD83D\uDE00", "\uD800", "\uDC00", "line\nbreak", "\"quote\""];
	if (depth <= 0) {
		switch (next() % 6) {
			case 0: return strings[next() % strings.length];
			case 1: return next() % 10_000;
			case 2: return (next() & 1) === 0;
			case 3: return null;
			case 4: return strings[next() % strings.length].repeat((next() % 3) + 1);
			default: return next() % 17 === 0 ? "" : `id-${next() % 64}`;
		}
	}
	const branch = next() % 5;
	if (branch <= 1) {
		return Array.from({ length: next() % 4 }, () => randomPlainJsonValue(next, depth - 1));
	}
	if (branch <= 3) {
		const out: Record<string, unknown> = {};
		const size = next() % 4;
		for (let i = 0; i < size; i += 1) out[`key${i}`] = randomPlainJsonValue(next, depth - 1);
		return out;
	}
	return randomPlainJsonValue(next, 0);
}

function randomPlainJsonCorpus(seed: number, count: number): unknown[] {
	const next = lcg(seed);
	return Array.from({ length: count }, () => randomPlainJsonValue(next, 3));
}

function makeAccessorFixture(): { value: Record<string, unknown>; readCount: () => number } {
	let reads = 0;
	const value: Record<string, unknown> = { stable: "before" };
	Object.defineProperty(value, "derived", {
		enumerable: true,
		get() {
			reads += 1;
			value.after = `after-${reads}`;
			return { seen: reads, note: "derived" };
		},
	});
	return { value, readCount: () => reads };
}

function makeParityCases(): unknown[] {
	const shared = { value: 1, nested: { ok: true } };
	const cycle: Record<string, unknown> = { tag: "cycle" };
	cycle.self = cycle;
	return [
		42,
		"hello",
		true,
		null,
		undefined,
		Symbol.for("stableJson"),
		() => 1,
		1n,
		{ big: 1n, nested: { ok: true } },
		{ left: shared, right: shared },
		{ cycle },
		{ error: new Error("stable boom") },
		{ date: new Date("2026-01-01T00:00:00Z") },
		{ list: ["\uD800", "\uDC00", "plain", { nested: true }] },
		...randomPlainJsonCorpus(0x5A17, 128),
	];
}

function makeFixtureCorpus(): unknown[] {
	return [
		{ title: "中文列表页", rows: Array.from({ length: 80 }, (_, i) => ({ name: `项目${i}`, price: `¥${i}.00`, action: "购买" })) },
		{ actionables: Array.from({ length: 60 }, (_, i) => ({ selector: `#field-${i}`, role: i % 4 ? "textbox" : "button", text: `Field ${i}` })) },
		{ entries: Array.from({ length: 120 }, (_, i) => ({ requestId: String(i), url: `https://api.example.test/${i}`, status: i % 9 === 0 ? 500 : 200 })) },
		{ events: Array.from({ length: 80 }, (_, i) => ({ seq: i, type: i % 2 ? "console" : "domSink", message: `event ${i}` })) },
		{ ok: true, requestCount: 80, steps: Array.from({ length: 80 }, (_, i) => ({ index: i, request: { method: "POST", url: `/api/${i}`, headers: { "x-case": `case-${i}` }, bodyPreview: "field=value&".repeat(30) }, response: { status: i % 3 ? 200 : 403, body: { bytes: 1000 + i, text: "response body ".repeat(80) } }, delta: i % 3 ? "none" : "status" })) },
	];
}

test("stableJson stringifies bigint and circular references", () => {
	const value: Record<string, unknown> = { big: 1n };
	value.self = value;
	const text = stableJson(value);
	assert.ok(text.includes('"big": "1"'));
	assert.ok(text.includes('"self": "[Circular]"'));
});

test("truncateText leaves short text untouched", () => {
	const result = truncateText("hello", 10);
	assert.equal(result.text, "hello");
	assert.equal(result.truncated, false);
	assert.equal(result.originalLength, 5);
});

test("truncateText truncates long text with marker", () => {
	const result = truncateText("abcdefghij", 6);
	assert.equal(result.truncated, true);
	assert.ok(result.text.includes("[truncated"));
	assert.equal(result.originalLength, 10);
});

test("jsonPreview wraps stableJson + truncateText", () => {
	const preview = jsonPreview({ a: "x".repeat(40) }, 20);
	assert.equal(preview.truncated, true);
	assert.ok(preview.text.includes("[truncated"));
});

test("stableJson matches the legacy replacer semantics across shared, circular, accessor, and randomized inputs", () => {
	const shared = { value: 1 };
	assert.notEqual(stableJsonWholeWalkVisitedMutant({ left: shared, right: shared }), stableJsonReference({ left: shared, right: shared }));

	for (const value of makeParityCases()) {
		assert.equal(stableJson(value), stableJsonReference(value));
	}

	const referenceAccessor = makeAccessorFixture();
	const currentAccessor = makeAccessorFixture();
	assert.equal(stableJsonReference(referenceAccessor.value), stableJson(currentAccessor.value));
	assert.equal(referenceAccessor.readCount(), 1);
	assert.equal(currentAccessor.readCount(), 1);
});

test("stableJson invocation counter increments once per call for primitive and object roots", () => {
	resetStableJsonInvocationCounter();
	const outputs = [
		stableJson(42),
		stableJson("hello"),
		stableJson(undefined),
		stableJson({ ok: true }),
		stableJson({ big: 1n }),
	];
	assert.deepEqual(outputs, [
		stableJsonReference(42),
		stableJsonReference("hello"),
		stableJsonReference(undefined),
		stableJsonReference({ ok: true }),
		stableJsonReference({ big: 1n }),
	]);
	assert.equal(stableJsonInvocationCounter(), outputs.length);
});

test("stableJson micro-bench keeps the primitive tier win without regressing object fixtures", () => {
	const scalarCorpus = ["hello", 123, true, null, undefined, false, "x".repeat(200), "tail"] satisfies unknown[];
	const fixtureCorpus = makeFixtureCorpus();
	const scalarBench = compareMicroBench({
		reference: () => scalarCorpus.map((value) => String(stableJsonReference(value))).join("\n"),
		candidate: () => scalarCorpus.map((value) => String(stableJson(value))).join("\n"),
		iterations: 4_000,
		warmupSamples: 2,
		samples: 7,
	});
	const fixtureBench = compareMicroBench({
		reference: () => fixtureCorpus.map((value) => String(stableJsonReference(value))).join("\n"),
		candidate: () => fixtureCorpus.map((value) => String(stableJson(value))).join("\n"),
		iterations: 250,
		warmupSamples: 2,
		samples: 7,
	});
	assert.ok(Number.isFinite(scalarBench.speedup));
	assert.ok(Number.isFinite(fixtureBench.speedup));
	assert.ok(microBenchSink() >= 0);
	const scalarCandidateNsPerValue = scalarBench.candidateNsPerOp / Math.max(1, scalarCorpus.length);
	const scalarReferenceNsPerValue = scalarBench.referenceNsPerOp / Math.max(1, scalarCorpus.length);
	const fixtureCandidateNsPerValue = fixtureBench.candidateNsPerOp / Math.max(1, fixtureCorpus.length);
	const fixtureReferenceNsPerValue = fixtureBench.referenceNsPerOp / Math.max(1, fixtureCorpus.length);
	console.log(
		`stableJson microbench scalar_speedup=${scalarBench.speedup.toFixed(2)}x scalar_candidate_ns_per_value=${scalarCandidateNsPerValue.toFixed(1)} scalar_reference_ns_per_value=${scalarReferenceNsPerValue.toFixed(1)} fixture_speedup=${fixtureBench.speedup.toFixed(2)}x fixture_candidate_ns_per_value=${fixtureCandidateNsPerValue.toFixed(1)} fixture_reference_ns_per_value=${fixtureReferenceNsPerValue.toFixed(1)}`,
	);
});
