import assert from "node:assert/strict";
import test from "node:test";
import { clusterMultipartParserResults } from "../../src/commands/webSecurity/browserNative/fuzzParams.ts";

test("multipart parser clusters aggregate fingerprints and ignore malformed count metadata", () => {
	const fingerprint = { location: "multipart", status: 200, title: "OK", bodyBytes: 12, bodySha256: "hash", responseLocation: "/done" };
	const clusters = clusterMultipartParserResults([
		{
			...fingerprint, matched: true, contentTypeVariant: "normal", paramName: "file", operation: "set",
			multipart: { partCount: 2, fileCount: 1, fieldCount: 1, nestedMultipartPartCount: 3, repeatedNameCounts: [{ name: "file" }, { name: "file" }, null] },
		},
		{
			...fingerprint, matched: false, contentTypeVariant: "normal", paramName: "upload", operation: "add",
			multipart: { partCount: "bad", fileCount: {}, fieldCount: -2, nestedMultipartPartCount: "bad", repeatedNameCounts: [{ name: "upload" }, { name: 7 }] },
		},
		{ location: "query", status: 200 },
		{ ...fingerprint, status: 500, multipart: {} },
	]);

	assert.equal(clusters.length, 2);
	assert.deepEqual(clusters[0], {
		key: "200|OK|12|hash|/done", status: 200, title: "OK", bodyBytes: 12, bodySha256: "hash", responseLocation: "/done",
		count: 2, matchedCount: 1, contentTypeVariants: ["normal"], params: ["file", "upload"], operations: ["set", "add"],
		multipartShapes: ["parts=2 files=1 fields=1 nested=3", "parts=0 files=0 fields=0 nested=0"], repeatedNames: ["file", "upload"], nestedMultipartPartCount: 3,
	});
	assert.equal(clusters[1].status, 500);
});

test("multipart parser clusters enforce per-field and result caps", () => {
	const repeated = Array.from({ length: 25 }, (_, index) => ({
		location: "multipart", status: 200, title: "same", bodyBytes: 1, bodySha256: "same", responseLocation: "",
		contentTypeVariant: `variant-${index}`, paramName: `param-${index}`, operation: `operation-${index}`,
		multipart: { partCount: index + 1, fileCount: 0, fieldCount: 0, nestedMultipartPartCount: index, repeatedNameCounts: [{ name: `name-${index}` }] },
	}));
	const bounded = clusterMultipartParserResults(repeated)[0];
	assert.equal(bounded.count, 25);
	assert.equal((bounded.contentTypeVariants as unknown[]).length, 20);
	assert.equal((bounded.params as unknown[]).length, 20);
	assert.equal((bounded.operations as unknown[]).length, 10);
	assert.equal((bounded.multipartShapes as unknown[]).length, 10);
	assert.equal((bounded.repeatedNames as unknown[]).length, 20);
	assert.equal(bounded.nestedMultipartPartCount, 24);

	const manyClusters = clusterMultipartParserResults(Array.from({ length: 55 }, (_, status) => ({ location: "multipart", status, multipart: {} })));
	assert.equal(manyClusters.length, 50);
	assert.deepEqual(manyClusters.map((cluster) => cluster.status), Array.from({ length: 50 }, (_, status) => status));
});
