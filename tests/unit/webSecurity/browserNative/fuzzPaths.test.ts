import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runFuzzPaths } from "../../../../src/tools/webSecurity/browserNative/fuzzPaths.ts";

test("fuzzPaths runs bounded path fuzzing against a local fixture", async () => {
	const server = createServer((req, res) => {
		if (req.url?.startsWith("/admin")) {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("admin panel");
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("missing");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing fuzzPaths test server address");
	try {
		const result = await runFuzzPaths({
			url: `http://127.0.0.1:${address.port}`,
			paths: ["admin", "missing"],
			matchStatus: [200],
			maxCandidates: 10,
			timeoutMs: 500,
			maxBodyBytes: 1024,
		});
		assert.equal(result.ok, true);
		assert.ok(result.requestCount >= 2);
		assert.ok(result.matched.some((item) => item.url.includes("/admin") && item.status === 200));
	} finally {
		server.close();
	}
});
