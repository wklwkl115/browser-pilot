import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runFuzzPaths } from "../../src/commands/webSecurity/browserNative/fuzzPaths.ts";

test("fuzz paths preserves baseline filtering, cookies, recursion, tuple replacement, caps, and failures", async (context) => {
	const requests: Array<{ url: string; cookie?: string }> = [];
	const server = createServer((request, response) => {
		const url = request.url || "/";
		requests.push({ url, cookie: request.headers.cookie });
		if (url === "/docs") {
			response.writeHead(302, { location: "/docs/" });
			return response.end();
		}
		if (url === "/docs/") {
			response.writeHead(200, { "content-type": "text/html" });
			return response.end("<title>Docs</title>directory");
		}
		if (["/admin", "/docs/admin", "/a/b"].includes(url)) {
			response.writeHead(200, { "content-type": "text/html" });
			return response.end(`<title>Found</title>${url}`);
		}
		response.writeHead(404, { "content-type": "text/plain" });
		return response.end("baseline missing");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/`;

	await assert.rejects(runFuzzPaths({ url: baseUrl, allowPrivateTargets: true }), (error: Error & { code?: string }) => {
		assert.equal(error.code, "INVALID_RULE");
		return true;
	});

	const filtered = await runFuzzPaths({
		url: baseUrl,
		paths: ["admin", "missing"],
		baselinePath: "__baseline__",
		baselineStrategy: "exact",
		filterBaseline: true,
		matchStatus: [200, 404],
		bindBrowserSession: true,
		cookieProvider: async () => ({ header: "sid=fixture" }),
		allowPrivateTargets: true,
	});
	assert.equal(filtered.ok, true);
	assert.equal(filtered.requestCount, 2);
	assert.equal(filtered.baselines.length, 4);
	assert.equal(filtered.matchedCount, 1);
	assert.equal(filtered.matched[0].candidate, "admin");
	assert.equal(filtered.results.find((item) => item.candidate === "missing")?.differentFromBaseline, false);
	assert.equal(requests.every((request) => request.cookie === "sid=fixture"), true);

	const recursive = await runFuzzPaths({
		url: baseUrl,
		paths: ["docs", "admin"],
		baselinePath: "__baseline__",
		filterBaseline: true,
		recursive: true,
		maxDepth: 2,
		followRedirects: true,
		allowPrivateTargets: true,
	});
	assert.equal(recursive.visitedBaseCount, 2);
	assert.equal(recursive.discoveredDirectoryCount, 1);
	assert.equal(recursive.requestCount, 4);
	assert.equal(recursive.results.some((item) => item.url === new URL("docs/admin", baseUrl).toString()), true);

	const tuple = await runFuzzPaths({
		url: `${baseUrl}FUZZ/FUZZ`,
		paths: ["a::b"],
		baselinePath: "__baseline__",
		allowPrivateTargets: true,
	});
	assert.equal(tuple.requestCount, 1);
	assert.equal(tuple.results[0].url, new URL("a/b", baseUrl).toString());

	const capped = await runFuzzPaths({
		url: baseUrl,
		paths: ["admin", "missing"],
		baselinePath: "__baseline__",
		maxCandidates: 1,
		maxDepth: 10,
		allowPrivateTargets: true,
	});
	assert.equal(capped.candidateCount, 1);
	assert.equal(capped.truncatedCandidates, 1);
	assert.match(capped.warnings?.[0] || "", /maxDepth capped/);

	const failed = await runFuzzPaths({
		urls: [baseUrl, "http://127.0.0.1:1/"],
		paths: ["admin"],
		baselinePath: "__baseline__",
		timeoutMs: 100,
		allowPrivateTargets: true,
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.baseCount, 2);
	assert.equal(failed.requestCount, 2);
	assert.equal(failed.failures.length, 1);
	assert.equal(failed.baselines.filter((item) => item.error).length, 4);
});
