import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSemanticText } from "../../src/kernels/abml/semanticText.ts";

test("semantic text keeps plain labels that merely start with an HTML tag name", () => {
	for (const label of [
		"link",
		"listbox",
		"gridcell",
		"alert",
		"generic",
		"About",
		"Account",
		"Apply",
		"Like",
		"Go",
		"Gallery",
		"Navigate",
		"Articles",
		"Inputs",
		"Buttons",
		"Spanish",
		"Main",
		"Add-on",
	])
		assert.equal(sanitizeSemanticText(label), label, `${label} is a real label`);
});

test("semantic text still drops selector-like and markup-like strings", () => {
	for (const selector of [
		"div.card",
		"li:nth-child(2)",
		"a[href]",
		"button > span",
		".btn-primary",
		"#main-nav",
		"<svg><path d='M0 0h24v24H0z'/></svg>",
		"M0 0, 24 24",
		"evenodd",
		"3f9a8c2e1d4b7f6a9c0e",
	])
		assert.equal(sanitizeSemanticText(selector), undefined, `${selector} is not a label`);
});

test("semantic text bounds length and strips markup", () => {
	assert.equal(sanitizeSemanticText("<b>Save</b> changes"), "Save changes");
	const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
	assert.equal(sanitizeSemanticText(long)?.length, 161);
	assert.ok(sanitizeSemanticText(long)?.endsWith("…"));
	assert.equal(sanitizeSemanticText("   "), undefined);
});
