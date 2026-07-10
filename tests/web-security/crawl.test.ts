import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBrowserCrawl } from "../../src/commands/webSecurity/browserNative/crawl.ts";

test("browser-native crawl discovers loopback pages, scripts, APIs, GraphQL, service workers, and source maps", async () => {
	const requests: Array<{ method?: string; url?: string }> = [];
	const server = createServer((request, response) => {
		requests.push({ method: request.method, url: request.url });
		if (request.url === "/failure") return request.socket.destroy();
		if (request.url === "/graphql" && request.method === "POST") {
			response.writeHead(200, { "content-type": "application/json" });
			return response.end(JSON.stringify({ data: { __schema: { queryType: { name: "Query" }, types: [{ name: "Query", fields: [{ name: "viewer", args: [] }] }] } } }));
		}
		const fixtures: Record<string, { type: string; body: string }> = {
			"/": { type: "text/html", body: "<!doctype html><title>Crawl Root</title><a href='/next'>Next</a><form action='/submit' method='post'><input name='email'></form><link rel='manifest' href='/manifest.json'><script src='/app.js'></script><script>fetch('/graphql');navigator.serviceWorker.register('/sw.js')</script>" },
			"/next": { type: "text/html", body: "<!doctype html><title>Next</title><a href='/api/page'>API page</a>" },
			"/app.js": { type: "application/javascript", body: "fetch('/api/items');navigator.serviceWorker.register('/sw.js');\n//# sourceMappingURL=/app.js.map" },
			"/sw.js": { type: "application/javascript", body: "const VERSION='smoke-v1';caches.open('browser-pilot-v1');importScripts('/worker-lib.js');self.addEventListener('fetch',()=>fetch('/api/cache'))" },
			"/app.js.map": { type: "application/json", body: JSON.stringify({ version: 3, file: "app.js", sources: ["src/app.ts"], sourcesContent: ["export const endpoint = '/api/from-source-map';"], names: [], mappings: "" }) },
			"/manifest.json": { type: "application/manifest+json", body: JSON.stringify({ name: "Smoke", start_url: "/" }) },
			"/robots.txt": { type: "text/plain", body: "Allow: /\nSitemap: /sitemap.xml" },
			"/graphql": { type: "application/json", body: JSON.stringify({ endpoint: "/graphql" }) },
		};
		const fixture = fixtures[request.url || ""];
		if (!fixture) {
			response.writeHead(404, { "content-type": "text/plain" });
			return response.end("missing");
		}
		response.writeHead(200, { "content-type": fixture.type });
		return response.end(fixture.body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.equal(typeof address, "object");
	const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
	const cwd = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-crawl-"));
	try {
		const result = await runBrowserCrawl({
			cwd,
			urls: [baseUrl, new URL("failure", baseUrl).toString()],
			knownFiles: "robots",
			maxDepth: 8,
			maxPages: 600,
			allowPrivateTargets: true,
			activeGraphqlIntrospection: true,
		});

		assert.equal(result.ok, false);
		assert.equal(result.failures.length, 1);
		assert.equal(result.maxDepth, 5);
		assert.equal(result.maxPages, 500);
		assert.equal(result.warnings?.length, 2);
		assert.equal(result.pages.some((page) => page.title === "Crawl Root"), true);
		assert.equal(result.pages.some((page) => page.url === new URL("app.js", baseUrl).toString()), true);
		assert.equal(result.endpoints.some((endpoint) => endpoint.url === new URL("submit", baseUrl).toString() && endpoint.kind === "form"), true);
		assert.equal(result.endpoints.some((endpoint) => endpoint.url === new URL("api/items", baseUrl).toString()), true);
		assert.equal(result.endpoints.some((endpoint) => endpoint.kind === "source-map"), true);
		assert.equal(result.sourceArchiveCount > 0, true);
		assert.equal(typeof result.artifactRoot, "string");
		const graphqlPage = result.pages.find((page) => page.url === new URL("graphql", baseUrl).toString());
		assert.equal((graphqlPage?.graphqlSchema as Record<string, unknown> | undefined)?.source, "active-probe");
		assert.equal(result.serviceWorkerCacheNames.includes("browser-pilot-v1"), true);
		assert.equal(result.serviceWorkerVersionTokens.includes("v1"), true);
		assert.equal(requests.some((entry) => entry.method === "POST" && entry.url === "/graphql"), true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(cwd, { recursive: true, force: true });
	}
});
