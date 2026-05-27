import test from "node:test";
import assert from "node:assert/strict";
import {
	absolutizeMaybe,
	extractAttributeUrls,
	extractForms,
	extractKnownFileUrls,
	extractScriptSources,
	extractServiceWorkerUrls,
	extractSourceMapUrls,
	extractStringUrls,
	knownFilePaths,
	normalizeUrlForVisit,
} from "../../../../src/tools/webSecurity/browserNative/crawlExtractors.ts";

test("crawlExtractors normalizeUrlForVisit strips hash", () => {
	assert.equal(normalizeUrlForVisit("https://example.test/a#frag"), "https://example.test/a");
});

test("crawlExtractors knownFilePaths expands all mode", () => {
	const paths = knownFilePaths("all");
	assert.ok(paths.includes("/robots.txt"));
	assert.ok(paths.includes("/openapi.json"));
});

test("crawlExtractors absolutizeMaybe rejects javascript urls", () => {
	assert.equal(absolutizeMaybe("javascript:alert(1)", "https://example.test/"), undefined);
});

test("crawlExtractors extracts links, scripts, forms, source maps, and service workers", () => {
	const html = `
		<html><head>
			<script src="/app.js"></script>
			<link rel="manifest" href="/site.webmanifest">
		</head><body>
			<a href="/next">next</a>
			<form method="post" action="/submit"><input name="email"></form>
		</body></html>`;
	assert.deepEqual(extractScriptSources(html, "https://example.test/base").sort(), ["https://example.test/app.js"]);
	assert.equal(extractForms(html, "https://example.test/")[0].action, "https://example.test/submit");
	assert.ok(extractAttributeUrls(html, "https://example.test/").some((item) => item.url === "https://example.test/next"));
	assert.deepEqual(extractSourceMapUrls("//# sourceMappingURL=/app.js.map", "https://example.test/app.js"), ["https://example.test/app.js.map"]);
	assert.deepEqual(extractServiceWorkerUrls("navigator.serviceWorker.register('/sw.js')", "https://example.test/"), ["https://example.test/sw.js"]);
});

test("crawlExtractors extracts URL strings and known file URLs", () => {
	const script = "fetch('/api/items'); axios.post('https://api.example.test/v1'); const x = '/graphql';";
	const urls = extractStringUrls(script, "https://example.test/page");
	assert.ok(urls.some((item) => item.url === "https://example.test/api/items"));
	assert.ok(urls.some((item) => item.url === "https://api.example.test/v1"));
	assert.ok(urls.some((item) => item.url === "https://example.test/graphql"));
	const known = extractKnownFileUrls("Sitemap: https://example.test/sitemap.xml", "https://example.test/");
	assert.deepEqual(known, [{ url: "https://example.test/sitemap.xml", kind: "known-file" }]);
});
