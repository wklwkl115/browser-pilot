import test from "node:test";
import assert from "node:assert/strict";
import { summarizeContentData } from "../../../src/tools/summaries/content.ts";

test("summarizeContentData returns type for non-record input", () => {
	assert.deepEqual(summarizeContentData(null), { type: "object" });
	assert.deepEqual(summarizeContentData("string"), { type: "string" });
});

test("summarizeContentData extracts url, title, selector", () => {
	const result = summarizeContentData({ url: "https://example.com", title: "Example", selector: "main" });
	assert.equal(result.url, "https://example.com");
	assert.equal(result.title, "Example");
	assert.equal(result.selector, "main");
});

test("summarizeContentData computes markdownChars from markdown string", () => {
	const result = summarizeContentData({ markdown: "hello world" });
	assert.equal(result.markdownChars, 11);
});

test("summarizeContentData uses stats.markdownChars when available", () => {
	const result = summarizeContentData({ markdown: "x", stats: { markdownChars: 999 } });
	assert.equal(result.markdownChars, 999);
});

test("summarizeContentData sets empty=false when not signalled", () => {
	const result = summarizeContentData({ markdown: "content" });
	assert.equal(result.empty, false);
});

test("summarizeContentData sets empty=true when signalled", () => {
	const result = summarizeContentData({ empty: true });
	assert.equal(result.empty, true);
});

test("summarizeContentData extracts headings slice", () => {
	const headings = Array.from({ length: 25 }, (_, i) => `H${i}`);
	const result = summarizeContentData({ headings });
	assert.ok(Array.isArray(result.headings));
	assert.ok((result.headings as unknown[]).length <= 20);
});

test("summarizeContentData produces textPreview from markdown", () => {
	const result = summarizeContentData({ markdown: "  some content  \n\n  here  " });
	assert.ok(typeof result.textPreview === "string");
	assert.ok((result.textPreview as string).includes("some content"));
});

test("summarizeContentData passes stats fields through", () => {
	const stats = { textChars: 500, links: 10, images: 3, paragraphs: 5, headings: 4, truncated: false };
	const result = summarizeContentData({ stats });
	assert.equal(result.textChars, 500);
	assert.equal(result.links, 10);
	assert.equal(result.images, 3);
	assert.equal(result.paragraphs, 5);
	assert.equal(result.headingsCount, 4);
	assert.equal(result.truncated, false);
});
