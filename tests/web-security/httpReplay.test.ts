import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runHttpReplay } from "../../src/commands/webSecurity/browserNative/httpReplay.ts";

type ReplayRequestSample = { url: string; method?: string; headers: Record<string, string | string[] | undefined>; body: string };

function record(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

async function replayFixture(context: { after: (fn: () => Promise<void>) => void }) {
	const requests: ReplayRequestSample[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const url = request.url || "/";
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ url, method: request.method, headers: { ...request.headers }, body });
			if (url === "/single") {
				const changed = request.headers["x-variant"] === "changed";
				response.writeHead(changed ? 201 : 200, { "content-type": "text/html" });
				return response.end(`<title>${changed ? "Changed" : "Baseline"}</title>${body}`);
			}
			if (url === "/redirect") {
				response.writeHead(302, { location: "/final" });
				return response.end();
			}
			if (url === "/final") {
				response.writeHead(202, { "content-type": "application/json" });
				return response.end(JSON.stringify({ redirected: true }));
			}
			if (url === "/login") {
				response.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=sequence; Path=/" });
				return response.end(JSON.stringify({ token: "abc" }));
			}
			if (url === "/use/abc") {
				response.writeHead(200, { "content-type": "application/json" });
				return response.end(JSON.stringify({ cookie: request.headers.cookie, token: request.headers["x-token"] }));
			}
			if (url === "/upload" || url === "/ok") {
				response.writeHead(200, { "content-type": "text/plain" });
				return response.end(body || "ok");
			}
			response.writeHead(404, { "content-type": "text/plain" });
			return response.end("missing");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

test("HTTP replay preserves single baseline comparison, redirects, sequence cookies, and captured variables", async (context) => {
	const { baseUrl, requests } = await replayFixture(context);
	const single = await runHttpReplay({
		url: `${baseUrl}/single`,
		method: "POST",
		headers: { Authorization: "Bearer fixture", Cookie: "source=one" },
		body: "payload",
		mutations: { headers: { "X-Variant": "changed" } },
		compareBaseline: true,
		bindBrowserSession: true,
		cookieMode: "merge",
		cookieProvider: async () => ({ header: "browser=two" }),
		allowPrivateTargets: true,
	});
	assert.equal(single.mode, "single");
	assert.equal(single.ok, true);
	assert.equal(record(single.response).status, 201);
	assert.equal(record(record(single.baseline).response).status, 200);
	assert.equal(record(single.delta).statusChanged, true);
	assert.equal(record(single.request).bodyBytes, 7);
	assert.equal(requests.filter((request) => request.url === "/single").every((request) => String(request.headers.cookie).includes("source=one") && String(request.headers.cookie).includes("browser=two")), true);

	const redirected = await runHttpReplay({ url: `${baseUrl}/redirect`, method: "POST", body: "drop-on-redirect", followRedirects: true, allowPrivateTargets: true });
	assert.equal(record(redirected.response).status, 202);
	assert.equal(record(redirected.response).url, `${baseUrl}/final`);
	assert.ok(Array.isArray(redirected.redirects));
	assert.equal(redirected.redirects.length, 1);
	assert.deepEqual(requests.filter((request) => ["/redirect", "/final"].includes(request.url)).map((request) => request.method), ["POST", "GET"]);

	const sequence = await runHttpReplay({
		sequence: [
			{ url: `${baseUrl}/login`, extractors: [{ name: "token", type: "json", jsonPath: "$.token" }] },
			{ url: `${baseUrl}/use/{{token}}`, headers: { "X-Token": "{{token}}" } },
		],
		sequenceCookies: true,
		variableScope: "sequence",
		allowPrivateTargets: true,
	});
	assert.equal(sequence.mode, "sequence");
	assert.equal(sequence.ok, true);
	assert.equal(sequence.stepCount, 2);
	assert.equal(record(sequence.variables).token, "abc");
	const useRequest = requests.find((request) => request.url === "/use/abc");
	assert.ok(useRequest);
	assert.match(String(useRequest.headers.cookie), /sid=sequence/);
	assert.equal(useRequest.headers["x-token"], "abc");
	assert.equal(Array.isArray(sequence.clusters), true);
});

test("HTTP replay preserves continue-on-error and bounded multipart file-field matrices", async (context) => {
	const { baseUrl, requests } = await replayFixture(context);
	const continued = await runHttpReplay({
		sequence: [{ url: "http://127.0.0.1:1/", timeoutMs: 100 }, { url: `${baseUrl}/ok` }],
		continueOnError: true,
		allowPrivateTargets: true,
	});
	assert.equal(continued.mode, "sequence");
	assert.equal(continued.ok, false);
	assert.equal(continued.stepCount, 2);
	assert.equal(continued.failureCount, 1);
	assert.equal(record(continued.response).status, 200);
	assert.equal(Array.isArray(continued.failures), true);
	assert.equal(continued.failures.length, 1);

	const multipart = {
		fields: { description: "fixture" },
		files: [{ name: "file", filename: "template.txt", content: "template", contentType: "text/plain" }],
		fileFieldMatrix: {
			fieldNames: ["file", "upload"],
			fileValues: [
				{ filename: "one.txt", content: "one", contentType: "text/plain" },
				[
					{ filename: "two-a.txt", content: "two-a", contentType: "text/plain" },
					{ filename: "two-b.bin", content: "two-b", contentType: "application/octet-stream" },
				],
			],
			maxCases: 3,
		},
	};
	const matrix = await runHttpReplay({ url: `${baseUrl}/upload`, method: "POST", multipart, allowPrivateTargets: true });
	assert.equal(matrix.mode, "multipart-matrix");
	assert.equal(matrix.stepCount, 3);
	assert.deepEqual(record(matrix.multipartMatrix), { caseCount: 3, truncatedCases: 1, fieldNames: ["file", "upload"], fileValueCount: 2, maxCases: 3 });
	const matrixSteps = matrix.steps as Array<Record<string, unknown>>;
	assert.deepEqual(matrixSteps.map((step) => record(step.multipartMatrixCase).kind), ["single-file", "multi-file", "single-file"]);
	assert.equal(requests.filter((request) => request.url === "/upload").length, 3);
	assert.equal(requests.filter((request) => request.url === "/upload").every((request) => /multipart\/form-data/.test(String(request.headers["content-type"]))), true);

	await assert.rejects(runHttpReplay({ url: `${baseUrl}/upload`, sequence: [{ url: `${baseUrl}/ok` }], multipart, allowPrivateTargets: true }), (error: Error & { code?: string }) => {
		assert.equal(error.code, "INVALID_RULE");
		return true;
	});
	await assert.rejects(runHttpReplay({ url: `${baseUrl}/upload`, multipart: { files: [], fileFieldMatrix: { fileValues: ["one"] } }, allowPrivateTargets: true }), /requires exactly one template file/);
	await assert.rejects(runHttpReplay({ url: `${baseUrl}/upload`, multipart, mutations: { multipart: {} }, allowPrivateTargets: true }), /cannot be combined with mutations\.multipart/);
});
