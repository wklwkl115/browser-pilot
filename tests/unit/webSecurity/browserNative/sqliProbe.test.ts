import test from "node:test";
import assert from "node:assert/strict";
import { runSqliProbe } from "../../../../src/tools/webSecurity/browserNative/sqliProbe.ts";
import { createServer } from "node:http";

test("webSecurity/browserNative/sqliProbe rejects when no parameters can be inferred", async () => {
	await assert.rejects(
		() => runSqliProbe({ url: "https://example.test/empty", probeTypes: ["error"], maxCases: 1 }),
		/paramNames|parameters/i,
	);
});

test("webSecurity/browserNative/sqliProbe accepts explicit query parameter probing with bounded config", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing test server address");
	try {
		const result = await runSqliProbe({
			url: `http://127.0.0.1:${address.port}/item?id=1`,
			locations: ["query"],
			paramNames: ["id"],
			probeTypes: ["union"],
			orderByMax: 1,
			unionColumnMax: 1,
			maxCases: 2,
			timeoutMs: 500,
			maxBodyBytes: 1024,
		});
		assert.equal(result.ok, true);
		assert.ok(result.caseCount <= 2);
		assert.equal(Array.isArray(result.results), true);
	} finally {
		server.close();
	}
});
