import assert from "node:assert/strict";
import test from "node:test";
import {
	isSuccessfulSemanticProgramResult,
	resolveSemanticActionCompletion,
} from "../../src/commands/operationResolvers.js";

const okFrames = [
	{ step: 0, kind: "mouse:press", ok: true, durationMs: 1 },
	{ step: 1, kind: "mouse:release", ok: true, durationMs: 1 },
	{ step: 2, kind: "text", ok: true, durationMs: 1 },
];

test("isSuccessfulSemanticProgramResult requires frames and rejects aborted", () => {
	assert.equal(isSuccessfulSemanticProgramResult(undefined), false);
	assert.equal(isSuccessfulSemanticProgramResult({ frames: [] }), false);
	assert.equal(isSuccessfulSemanticProgramResult({
		frames: okFrames,
		aborted: { reason: "ref precheck failed — dead refs: bp-ref://missing", atStep: -1 },
	}), false);
	assert.equal(isSuccessfulSemanticProgramResult({
		frames: [{ step: 0, kind: "mouse:press", ok: false, durationMs: 1, error: "ref not in registry" }],
	}), false);
	assert.equal(isSuccessfulSemanticProgramResult({ frames: okFrames, result: { ok: true } }), true);
});

test("semantic.fill does not complete on aborted or failed program", () => {
	const aborted = resolveSemanticActionCompletion("semantic.fill", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: {
			frames: [{ step: 0, kind: "mouse:press", ok: false, durationMs: 1, error: "dead ref" }],
			result: undefined,
			aborted: { reason: "ref precheck failed — dead refs: bp-ref://fixture/email", atStep: -1 },
		},
		events: [{ type: "mutation", operationId: "op", sequence: 1, timestamp: 1, progress: true, data: { mutationCount: 1 } }],
	});
	assert.equal(aborted, undefined);

	const failedFrame = resolveSemanticActionCompletion("semantic.fill", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: {
			frames: [
				{ step: 0, kind: "mouse:press", ok: true, durationMs: 1 },
				{ step: 1, kind: "text", ok: false, durationMs: 1, error: "pointer failed" },
			],
			aborted: { reason: "frame failed", atStep: 1 },
		},
		events: [],
	});
	assert.equal(failedFrame, undefined);

	// Bare defined object without successful frames must not complete either.
	const bare = resolveSemanticActionCompletion("semantic.fill", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: { frames: [], result: { ok: true } },
		events: [],
	});
	assert.equal(bare, undefined);
});

test("semantic.fill completes only on successful program frames", () => {
	const done = resolveSemanticActionCompletion("semantic.fill", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: { frames: okFrames, result: { ok: true } },
		events: [],
	});
	assert.ok(done);
	assert.equal(done?.source, "semantic-fill-applied");
});

test("semantic.scroll does not complete on aborted program", () => {
	const aborted = resolveSemanticActionCompletion("semantic.scroll", {
		commandName: "browser_execute",
		mode: "program",
		physicalProgram: true,
		result: {
			frames: [{ step: 0, kind: "mouse:wheel", ok: false, durationMs: 1 }],
			aborted: { reason: "frame failed", atStep: 0 },
		},
		events: [],
	});
	assert.equal(aborted, undefined);
});
