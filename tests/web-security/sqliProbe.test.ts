import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runSqliProbe } from "../../src/commands/webSecurity/browserNative/sqliProbe.ts";

test("SQLi probe preserves boolean/error evidence and request accounting", async (context) => {
	const server = createServer((request, response) => {
		const value = new URL(request.url || "/", "http://localhost").searchParams.get("id") || "";
		const body = value.includes("1=2") ? "false branch" : value.endsWith("'") ? "SQL syntax error near quote" : "normal branch";
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const result = await runSqliProbe({
		url: `http://127.0.0.1:${address.port}/probe?id=1`,
		method: "GET",
		locations: ["query"],
		paramNames: ["id"],
		probeTypes: ["boolean", "error"],
		booleanPayloadPairs: [{ name: "pair", truePayload: "' AND 1=1--", falsePayload: "' AND 1=2--" }],
		errorPayloads: ["'"],
		maxCases: 2,
		baselineRepeats: 1,
		unionEcho: false,
		allowPrivateTargets: true,
		timeoutMs: 2_000,
	});

	assert.equal(result.ok, true);
	assert.equal(result.caseCount, 2);
	assert.equal(result.requestCount, 3);
	assert.equal(result.matchedCount, 2);
	assert.deepEqual(result.oracleTypes, ["boolean", "error"]);
	assert.deepEqual(result.results.map((item) => [item.type, item.matched]), [["boolean", true], ["error", true]]);
	assert.deepEqual(result.failures, []);
});
