import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectJsonValue } from "../../../src/distill-core/projection.ts";
import { stableJson } from "../../../src/utils/json.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function replayActionables(): Record<string, unknown>[] {
	const fixturePath = path.join(root, "tests", "fixtures", "observe-scan-1781174652248.redacted.json");
	const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { data: { actionables: Record<string, unknown>[] } };
	return fixture.data.actionables;
}

test("projectJsonValue folds the 80-actionable replay fixture deterministically", () => {
	const actionables = replayActionables();
	const projected = projectJsonValue(actionables, { jsonPath: "data.actionables", maxChars: 8_000 });
	const repeated = projectJsonValue(actionables, { jsonPath: "data.actionables", maxChars: 8_000 });
	assert.equal(projected?.projection, "folded-v1");
	assert.equal(projected.count, 80);
	assert.equal(projected.items.length, 80);
	assert.equal(projected.items[0].i, 0);
	assert.equal(projected.items[79].i, 79);
	assert.deepEqual(projected.template.constants?.handlers, []);
	assert.equal(projected.frontier.retrieve.jsonPath, "data.actionables");
	assert.equal(stableJson(projected), stableJson(repeated), "same input and options must be byte-identical");
});

test("projectJsonValue preserves explicit item offset and limit", () => {
	const actionables = replayActionables();
	const projected = projectJsonValue(actionables, { jsonPath: "data.actionables", offset: 10, limit: 5, maxChars: 8_000 });
	assert.equal(projected?.offset, 10);
	assert.equal(projected?.limit, 5);
	assert.equal(projected?.nextOffset, 15);
	assert.deepEqual(projected?.items.map((item) => item.i), [10, 11, 12, 13, 14]);
	assert.equal(projected?.frontier.dropped.items, 75);
	assert.equal(projected?.frontier.retrieve.offset, 10);
	assert.equal(projected?.frontier.retrieve.limit, 5);
});

test("projectJsonValue selects scored membership then renders in source order", () => {
	const items = Array.from({ length: 8 }, (_, index) => ({
		index,
		kind: "candidate",
		label: `item ${index}`,
	}));
	const projected = projectJsonValue(items, {
		jsonPath: "items",
		limit: 3,
		maxChars: 4_000,
		scoreItem: (_item, sourceIndex) => sourceIndex === 6 ? 100 : sourceIndex === 2 ? 80 : sourceIndex === 4 ? 60 : 0,
	});
	assert.equal(projected?.projection, "folded-v1");
	assert.deepEqual(projected?.items.map((item) => item.i), [2, 4, 6]);
	assert.equal(projected?.frontier.dropped.items, 5);
});

test("projectJsonValue with no relevance score degrades to source-order membership", () => {
	const items = Array.from({ length: 8 }, (_, index) => ({
		index,
		kind: "candidate",
		label: `item ${index}`,
	}));
	const projected = projectJsonValue(items, {
		jsonPath: "items",
		limit: 3,
		maxChars: 4_000,
		scoreItem: () => 0,
	});
	assert.deepEqual(projected?.items.map((item) => item.i), [0, 1, 2]);
});

test("projectJsonValue folds near-constant fields as exceptions", () => {
	const items = Array.from({ length: 8 }, (_, index) => ({
		index,
		kind: "control",
		hitOk: index === 5 ? false : true,
		name: `item ${index}`,
	}));
	const projected = projectJsonValue(items, { jsonPath: "items", maxChars: 4_000 });
	assert.equal(projected?.template.constants?.kind, "control");
	assert.deepEqual(projected?.template.exceptions?.hitOk, { default: true, items: [[5, false]] });
	assert.equal(projected?.fields.includes("hitOk"), false);
});

test("projectJsonValue folds all-variant homogeneous arrays", () => {
	const items = Array.from({ length: 12 }, (_, index) => ({
		i: index,
		title: `Video title ${index}`,
		uploader: `Uploader ${index}`,
		href: `https://example.test/video/${index}`,
	}));
	const projected = projectJsonValue(items, { jsonPath: "data.cards", limit: 8, maxChars: 4_000 });
	assert.equal(projected?.projection, "folded-v1");
	assert.equal(projected?.count, 12);
	assert.equal(projected?.limit, 8);
	assert.equal(projected?.nextOffset, 8);
	assert.equal(projected?.fields.includes("title"), true);
	assert.equal(JSON.stringify(projected).includes("Video title 0"), true);
	assert.equal(projected?.frontier.retrieve.jsonPath, "data.cards");
});

test("projectJsonValue records dropped fields in the frontier when budget is tight", () => {
	const items = Array.from({ length: 20 }, (_, index) => ({
		index,
		kind: "control",
		name: `item ${index}`,
		selector: `form.example > section:nth-of-type(${index}) > div.${"long-class-".repeat(20)}${index}`,
	}));
	const projected = projectJsonValue(items, { jsonPath: "items", maxChars: 1_200 });
	assert.equal(projected?.projection, "folded-v1");
	assert.equal(projected.items.length, 20);
	assert.ok(projected.frontier.dropped.count > 0);
	assert.ok(projected.frontier.dropped.fields?.includes("selector"));
	assert.equal(projected.frontier.retrieve.jsonPath, "items");
});

test("projectJsonValue declines heterogeneous and empty arrays", () => {
	assert.equal(projectJsonValue([], { jsonPath: "items" }), undefined);
	assert.equal(projectJsonValue([{ a: 1 }, "mixed"], { jsonPath: "items" }), undefined);
});
