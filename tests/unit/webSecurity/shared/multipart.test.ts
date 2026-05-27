import test from "node:test";
import assert from "node:assert/strict";
import {
	buildMultipartBody,
	buildMultipartBodyFromParts,
	multipartContentTypeVariants,
	multipartPartsFromValue,
	parseMultipartBody,
	setMultipartContentTypeVariant,
	summarizeMultipartParts,
} from "../../../../src/tools/webSecurity/shared/multipart.ts";

test("multipart builds and parses a simple multipart body", () => {
	const built = buildMultipartBody({
		fields: { name: "alice" },
		files: [{ name: "avatar", filename: "a.txt", contentType: "text/plain", content: "hello" }],
	});
	assert.ok(built);
	const parsed = parseMultipartBody(built!.body, built!.contentType);
	assert.equal(parsed.parts.length, 2);
	assert.equal(parsed.parts[0].name, "name");
	assert.equal(parsed.parts[1].filename, "a.txt");
});

test("multipartPartsFromValue keeps file descriptor metadata", () => {
	const parts = multipartPartsFromValue("upload", { filename: "x.bin", contentType: "application/octet-stream", content: "abc" });
	assert.equal(parts[0].filename, "x.bin");
	assert.equal(parts[0].contentType, "application/octet-stream");
});

test("buildMultipartBodyFromParts creates deterministic content type", () => {
	const built = buildMultipartBodyFromParts([{ name: "a", body: Buffer.from("1") }], "boundary-1");
	assert.equal(built.contentType, "multipart/form-data; boundary=boundary-1");
	assert.match(built.body.toString("utf8"), /name="a"/);
});

test("multipart content type variants normalize and set header values", () => {
	assert.deepEqual(multipartContentTypeVariants(["quoted", "mismatch", "quoted"]), ["quoted", "mismatch"]);
	const headers: Record<string, string> = {};
	setMultipartContentTypeVariant(headers, "abc", "quoted");
	assert.equal(headers["Content-Type"], 'multipart/form-data; boundary="abc"');
	setMultipartContentTypeVariant(headers, "abc", "missing-boundary");
	assert.equal(headers["Content-Type"], "multipart/form-data");
});

test("summarizeMultipartParts reports repeated names and nested multipart hints", () => {
	const summary = summarizeMultipartParts([
		{ name: "a", body: Buffer.from("1") },
		{ name: "a", body: Buffer.from("2") },
		{ name: "nested", filename: "blob", contentType: "multipart/mixed", body: Buffer.from("3") },
	], "b", "normal");
	assert.equal(summary.partCount, 3);
	assert.equal(summary.nestedMultipartPartCount, 1);
	assert.deepEqual(summary.repeatedNameCounts, [{ name: "a", count: 2 }]);
});
