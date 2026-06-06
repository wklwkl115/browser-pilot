import test from "node:test";
import assert from "node:assert/strict";
import { isRecord, recordValue, toTabId } from "../../../src/utils/records.ts";

// ── isRecord ─────────────────────────────────────────────────────────────────

test("isRecord returns true for plain objects", () => {
	assert.equal(isRecord({ a: 1 }), true);
	assert.equal(isRecord({}), true);
	assert.equal(isRecord({ nested: { x: 1 } }), true);
});

test("isRecord returns false for arrays", () => {
	assert.equal(isRecord([]), false);
	assert.equal(isRecord([1, 2, 3]), false);
});

test("isRecord returns false for primitives and null", () => {
	assert.equal(isRecord(null), false);
	assert.equal(isRecord(undefined), false);
	assert.equal(isRecord(42), false);
	assert.equal(isRecord("string"), false);
	assert.equal(isRecord(true), false);
});

// ── recordValue ───────────────────────────────────────────────────────────────

test("recordValue returns the object when it is a record", () => {
	const obj = { x: 1 };
	assert.equal(recordValue(obj), obj);
});

test("recordValue returns undefined for non-record values", () => {
	assert.equal(recordValue(null), undefined);
	assert.equal(recordValue([]), undefined);
	assert.equal(recordValue("str"), undefined);
	assert.equal(recordValue(42), undefined);
});

// ── toTabId ───────────────────────────────────────────────────────────────────

test("toTabId returns positive integer from number", () => {
	assert.equal(toTabId(1), 1);
	assert.equal(toTabId(99), 99);
});

test("toTabId returns positive integer from numeric string", () => {
	assert.equal(toTabId("42"), 42);
	assert.equal(toTabId("1"), 1);
});

test("toTabId returns undefined for 0 and negative numbers", () => {
	assert.equal(toTabId(0), undefined);
	assert.equal(toTabId(-1), undefined);
});

test("toTabId returns undefined for non-integers", () => {
	assert.equal(toTabId(1.5), undefined);
	assert.equal(toTabId(NaN), undefined);
});

test("toTabId returns undefined for non-numeric values", () => {
	assert.equal(toTabId("abc"), undefined);
	assert.equal(toTabId(null), undefined);
	assert.equal(toTabId(undefined), undefined);
	assert.equal(toTabId({}), undefined);
});
