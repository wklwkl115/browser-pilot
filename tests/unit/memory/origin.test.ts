import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOriginKeyFromUrl } from "../../../src/tools/memory/origin.ts";

test("normalizeOriginKeyFromUrl folds device/variant subdomains into the apex", () => {
	for (const host of ["www", "www2", "m", "mobile", "app"]) {
		assert.equal(normalizeOriginKeyFromUrl(`https://${host}.site.com/x`), "site.com", `${host}. must fold to apex`);
	}
	// only a single LEADING known prefix is stripped; other subdomains stay.
	assert.equal(normalizeOriginKeyFromUrl("https://shop.www.site.com/"), "shop.www.site.com");
	assert.equal(normalizeOriginKeyFromUrl("https://maps.google.com/"), "maps.google.com");
	// two-label apex domains whose first label IS a prefix must NOT be mangled to a TLD.
	for (const apex of ["app.com", "mobile.de", "m.me", "www.io"]) {
		assert.equal(normalizeOriginKeyFromUrl(`https://${apex}/x`), apex, `${apex} must stay intact (not stripped to a bare TLD)`);
	}
});

test("normalizeOriginKeyFromUrl drops port and lowercases host", () => {
	assert.equal(normalizeOriginKeyFromUrl("https://Site.COM:8443/x?y=1"), "site.com");
});

test("normalizeOriginKeyFromUrl keeps localhost and IP literals verbatim", () => {
	assert.equal(normalizeOriginKeyFromUrl("http://localhost:3000/"), "localhost");
	assert.equal(normalizeOriginKeyFromUrl("https://127.0.0.1/x"), "127.0.0.1");
	assert.match(normalizeOriginKeyFromUrl("https://[::1]/"), /::1/);
});

test("normalizeOriginKeyFromUrl rejects non-absolute or host-less URLs", () => {
	for (const bad of ["not a url", "/relative/path", "about:blank"]) {
		assert.throws(() => normalizeOriginKeyFromUrl(bad), (err: { code?: string }) => err.code === "MEMORY_SCHEMA_INVALID");
	}
});
