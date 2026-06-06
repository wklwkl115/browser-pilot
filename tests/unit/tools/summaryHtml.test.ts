import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHtmlSnapshot } from "../../../src/tools/summaries/html.ts";

test("summarizeHtmlSnapshot returns basic metadata for simple HTML", () => {
	const html = "<html><body><h1>Hello</h1><p>World</p></body></html>";
	const result = summarizeHtmlSnapshot(html);
	assert.ok(typeof result.chars === "number");
	assert.equal(result.chars, html.length);
	assert.ok(typeof result.textChars === "number");
	assert.ok(result.textChars! > 0);
});

test("summarizeHtmlSnapshot extracts title from HTML", () => {
	const html = "<html><head><title>My Page</title></head><body>Content</body></html>";
	const result = summarizeHtmlSnapshot(html);
	assert.ok(Array.isArray(result.titles));
	assert.ok((result.titles as string[]).includes("My Page"));
});

test("summarizeHtmlSnapshot counts links, buttons, inputs, forms, images", () => {
	const html = `<html><body>
		<a href="/one">Link 1</a>
		<a href="/two">Link 2</a>
		<button>Click</button>
		<input type="text"/>
		<form></form>
		<img src="x.png"/>
	</body></html>`;
	const result = summarizeHtmlSnapshot(html);
	const counts = result.counts as Record<string, number>;
	assert.ok(counts.links >= 2);
	assert.ok(counts.buttons >= 1);
	assert.ok(counts.inputs >= 1);
	assert.ok(counts.forms >= 1);
	assert.ok(counts.images >= 1);
});

test("summarizeHtmlSnapshot removes script and style content from text", () => {
	const html = "<html><body><script>var x = 1;</script><p>Visible</p><style>.a{color:red}</style></body></html>";
	const result = summarizeHtmlSnapshot(html);
	const preview = result.textPreview as string;
	assert.ok(!preview.includes("var x"), "script content should be removed");
	assert.ok(!preview.includes(".a{color:red}"), "style content should be removed");
	assert.ok(preview.includes("Visible"));
});

test("summarizeHtmlSnapshot produces textPreview string", () => {
	const html = "<html><body><p>Some page text here</p></body></html>";
	const result = summarizeHtmlSnapshot(html);
	assert.ok(typeof result.textPreview === "string");
	assert.ok((result.textPreview as string).length > 0);
});

test("summarizeHtmlSnapshot passes selector and mode from meta", () => {
	const html = "<div><p>Content</p></div>";
	const result = summarizeHtmlSnapshot(html, { selector: "div", mode: "outer" });
	assert.equal(result.selector, "div");
	assert.equal(result.mode, "outer");
});

test("summarizeHtmlSnapshot uses meta textChars when provided", () => {
	const html = "<p>short</p>";
	const result = summarizeHtmlSnapshot(html, { text_length: 999 });
	assert.equal(result.textChars, 999);
});
