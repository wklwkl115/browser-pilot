import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import test from "node:test";
import { runFuzzVhosts } from "../../src/commands/webSecurity/browserNative/fuzzVhosts.ts";

function privateIpv4Address(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses || []) {
			if (address.family !== "IPv4" || address.internal) continue;
			const octets = address.address.split(".").map(Number);
			if (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)) return address.address;
		}
	}
	return undefined;
}

test("fuzz vhosts preserves host probing, baseline filtering, redirects, caps, private-target opt-in, and failures", async (context) => {
	const requests: Array<{ url: string; host: string; method?: string; cookie?: string }> = [];
	const server = createServer((request, response) => {
		const url = request.url || "/";
		const host = String(request.headers.host || "");
		requests.push({ url, host, method: request.method, cookie: request.headers.cookie });
		if (host === "redirect.test" && url === "/") {
			response.writeHead(302, { location: "/landing" });
			return response.end();
		}
		if (host === "redirect.test" && url === "/landing") {
			response.writeHead(201, { "content-type": "text/html" });
			return response.end("<title>Redirected</title>redirect target");
		}
		if (host === "admin.test" || host === "admin.example.test") {
			response.writeHead(200, { "content-type": "text/html" });
			return response.end(`<title>Found</title>${host}`);
		}
		if (host === "binary.test") {
			response.writeHead(200, { "content-type": "application/octet-stream" });
			return response.end("binary-body");
		}
		response.writeHead(404, { "content-type": "text/plain" });
		return response.end("baseline missing");
	});
	await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
	context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/`;

	await assert.rejects(runFuzzVhosts({ url: baseUrl, allowPrivateTargets: true }), (error: Error & { code?: string }) => {
		assert.equal(error.code, "INVALID_RULE");
		return true;
	});

	const requestStart = requests.length;
	const filtered = await runFuzzVhosts({
		url: baseUrl,
		hosts: ["admin.test", "missing.test"],
		baselineHost: "baseline.test",
		baselineStrategy: "exact",
		filterBaseline: true,
		matchStatus: [200, 404],
		sniMode: "host",
		bindBrowserSession: true,
		cookieProvider: async () => ({ header: "sid=fixture" }),
		allowPrivateTargets: true,
	});
	assert.equal(filtered.ok, true);
	assert.equal(filtered.requestCount, 2);
	assert.equal(filtered.baselines.length, 1);
	assert.equal(filtered.matchedCount, 1);
	assert.equal(filtered.matched[0].host, "admin.test");
	assert.equal(filtered.results.find((item) => item.host === "missing.test")?.differentFromBaseline, false);
	assert.deepEqual(filtered.results.map((item) => item.sniName), ["admin.test", "missing.test"]);
	assert.equal(requests.slice(requestStart).every((request) => request.cookie === "sid=fixture"), true);

	const redirected = await runFuzzVhosts({
		url: baseUrl,
		hosts: ["redirect.test"],
		baselineHost: "baseline.test",
		filterBaseline: false,
		followRedirects: true,
		method: "POST",
		matchStatus: [201],
		sniMode: "custom",
		sniName: "tls.example.test",
		allowPrivateTargets: true,
	});
	assert.equal(redirected.results[0].status, 201);
	assert.equal(redirected.results[0].url, new URL("/landing", baseUrl).toString());
	const redirects = redirected.results[0].redirects;
	assert.ok(Array.isArray(redirects));
	assert.equal(redirects.length, 1);
	assert.equal(redirected.results[0].sniName, "tls.example.test");
	assert.deepEqual(requests.filter((request) => request.host === "redirect.test").map((request) => request.method), ["POST", "GET"]);

	const capped = await runFuzzVhosts({
		url: baseUrl,
		words: ["admin", "missing"],
		template: "FUZZ.example.test",
		baselineHost: "baseline.test",
		maxCandidates: 1,
		allowPrivateTargets: true,
	});
	assert.equal(capped.requestCount, 1);
	assert.equal(capped.truncatedCandidates, 1);
	assert.equal(capped.results[0].host, "admin.example.test");

	const binary = await runFuzzVhosts({ url: baseUrl, hosts: ["binary.test"], baselineHost: "baseline.test", filterBaseline: false, maxBodyBytes: 3, allowPrivateTargets: true });
	assert.equal(binary.results[0].sniName, "127.0.0.1");
	assert.equal(binary.results[0].bodyTruncated, true);
	const binaryBody = binary.results[0].body as { base64?: unknown };
	assert.equal(typeof binaryBody.base64, "string");

	const warned = await runFuzzVhosts({ url: baseUrl, hosts: ["admin.test"], baselineHost: "baseline.test", maxCandidates: 6_000, sniMode: "none", allowPrivateTargets: true });
	assert.match(warned.warnings?.[0] || "", /maxCandidates capped from 6000 to 5000/);
	assert.equal(warned.results[0].sniName, undefined);

	const privateAddress = privateIpv4Address();
	assert.ok(privateAddress, "expected a non-loopback RFC1918 address for private-target coverage");
	const privateUrl = `http://${privateAddress}:${address.port}/`;
	const denied = await runFuzzVhosts({ url: privateUrl, hosts: ["admin.test"], baselineHost: "baseline.test", timeoutMs: 500 });
	assert.equal(denied.ok, false);
	assert.match(String(denied.failures[0]?.error), /requires explicit allowPrivateTargets opt-in/);
	const allowed = await runFuzzVhosts({ url: privateUrl, hosts: ["admin.test"], baselineHost: "baseline.test", timeoutMs: 500, allowPrivateTargets: true });
	assert.equal(allowed.ok, true);
	assert.equal(allowed.results[0].status, 200);

	const failed = await runFuzzVhosts({
		url: "http://127.0.0.1:1/",
		hosts: ["admin.test"],
		baselineHost: "baseline.test",
		timeoutMs: 100,
		allowPrivateTargets: true,
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.requestCount, 1);
	assert.equal(failed.failures.length, 1);
	assert.equal(failed.baselines.filter((item) => item.error).length, 1);
});
