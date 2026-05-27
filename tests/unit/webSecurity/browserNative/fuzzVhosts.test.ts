import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { runFuzzVhosts } from "../../../../src/tools/webSecurity/browserNative/fuzzVhosts.ts";

test("fuzzVhosts distinguishes host-header candidates with a local fixture", async () => {
	const server = createServer((req, res) => {
		if (req.headers.host === "admin.example.test") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("admin host");
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("missing host");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing fuzzVhosts test server address");
	try {
		const result = await runFuzzVhosts({
			url: `http://127.0.0.1:${address.port}`,
			hosts: ["admin.example.test", "missing.example.test"],
			matchStatus: [200],
			maxCandidates: 10,
			timeoutMs: 500,
			maxBodyBytes: 1024,
			filterBaseline: false,
		});
		assert.equal(result.ok, true);
		assert.ok(result.requestCount >= 2);
		assert.ok(result.matched.some((item) => item.host === "admin.example.test" && item.status === 200));
	} finally {
		server.close();
	}
});
