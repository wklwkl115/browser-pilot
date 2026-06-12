import assert from "node:assert/strict";
import test from "node:test";
import { preserveMarkdownTableCells, replaceManagedBlock } from "../../../scripts/lib/managed-blocks.mjs";

test("replaceManagedBlock rewrites only the named generated span", () => {
	const text = "a\n<!-- BEGIN GENERATED: x (npm run docs:sync) -->\nold\n<!-- END GENERATED: x -->\nz\n";
	assert.equal(
		replaceManagedBlock(text, "x", "new"),
		"a\n<!-- BEGIN GENERATED: x (npm run docs:sync) -->\nnew\n<!-- END GENERATED: x -->\nz\n",
	);
});

test("preserveMarkdownTableCells keeps hand judgment cells by row id", () => {
	const oldTable = "| Key | Generated | Notes |\n| --- | --- | --- |\n| a | old | keep me |\n";
	const next = preserveMarkdownTableCells(oldTable, [["a", "new", ""], ["b", "new", ""]], { keyColumn: 0, preserveColumns: [2] });
	assert.deepEqual(next, [["a", "new", "keep me"], ["b", "new", ""]]);
});
