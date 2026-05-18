import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createSecureContext } from "node:tls";
import { buildReplayRequest, parseRawHttpRequest, runBrowserCrawl, runCallbackOast, runCookieAnalyze, runFuzzParams, runFuzzPaths, runFuzzVhosts, runHttpReplay, runNucleiBridge, runReconProbe, runSqlmapBridge, runSqliProbe, runTemplateCheck } from "../../src/tools/webSecurityCore.ts";
import { summarizeBrowserCrawlData, summarizeCallbackOastData, summarizeCookieAnalyzeData, summarizeFuzzParamsData, summarizeFuzzPathsData, summarizeFuzzVhostsData, summarizeHttpReplayData, summarizeNucleiBridgeData, summarizeSqlmapBridgeData, summarizeSqliProbeData, summarizeTemplateCheckData, summarizeWebReconProbeData } from "../../src/tools/summaries/index.ts";
import { ALT_HTTPS_CERT_PEM, ALT_HTTPS_KEY_PEM, DEFAULT_HTTPS_CERT_PEM, DEFAULT_HTTPS_KEY_PEM } from "../fixtures/https-sni-certs.mjs";

function b64u(value) {
	return Buffer.from(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hs256Jwt(payload, secret) {
	const input = `${b64u({ alg: "HS256", typ: "JWT", kid: "fixture" })}.${b64u(payload)}`;
	const sig = createHmac("sha256", secret).update(input).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	return `${input}.${sig}`;
}

function directJwe(payload, secret) {
	const header = { alg: "dir", enc: "A256GCM", typ: "JWE", kid: "fixture-jwe" };
	const protectedHeader = b64u(header);
	const iv = Buffer.alloc(12, 1);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "utf8"), iv);
	cipher.setAAD(Buffer.from(protectedHeader, "utf8"));
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${protectedHeader}..${b64u(iv)}.${b64u(ciphertext)}.${b64u(tag)}`;
}

function djangoSigned(payload, secret) {
	const payloadPart = b64u(JSON.stringify(payload));
	const timestamp = "1";
	const key = createHash("sha256").update(`django.core.signingsigner${secret}`, "utf8").digest();
	const signature = b64u(createHmac("sha256", key).update(`${payloadPart}:${timestamp}`, "utf8").digest());
	return `${payloadPart}:${timestamp}:${signature}`;
}

function flaskSigned(payload, secret) {
	const payloadPart = b64u(JSON.stringify(payload));
	const timestamp = b64u(Buffer.from([1]));
	const key = createHmac("sha1", secret).update("cookie-session", "utf8").digest();
	const signature = b64u(createHmac("sha1", key).update(`${payloadPart}.${timestamp}`, "utf8").digest());
	return `${payloadPart}.${timestamp}.${signature}`;
}

function railsSigned(payload, secret) {
	const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	const key = pbkdf2Sync(secret, "signed cookie", 1000, 64, "sha1");
	const signature = createHmac("sha1", key).update(payloadPart, "utf8").digest("hex");
	return `${payloadPart}--${signature}`;
}

function pasetoFixture(footer = { kid: "fixture-paseto" }) {
	return `v4.local.${b64u("opaque-payload")}.${b64u(footer)}`;
}

function jwtPayload(token) {
	try {
		return JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
	} catch {
		return undefined;
	}
}

function parseMultipartFixture(body, contentType) {
	const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.[2];
	if (!boundary) return { error: "missing-boundary", fields: {}, files: [] };
	const raw = body.toString("latin1");
	const parts = raw.split(`--${boundary}`);
	const fields = {};
	const files = [];
	for (let part of parts) {
		if (!part || part === "--\r\n" || part === "--" || part === "\r\n") continue;
		if (part.startsWith("\r\n")) part = part.slice(2);
		if (part.endsWith("\r\n")) part = part.slice(0, -2);
		if (part.endsWith("--")) part = part.slice(0, -2);
		const splitAt = part.indexOf("\r\n\r\n");
		if (splitAt < 0) continue;
		const head = part.slice(0, splitAt);
		const payload = part.slice(splitAt + 4);
		const disp = head.match(/name="([^"]+)"(?:; filename="([^"]*)")?/i);
		const partContentType = head.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
		if (!disp) continue;
		if (disp[2] !== undefined) files.push({ name: disp[1], filename: disp[2], contentType: partContentType, content: payload });
		else fields[disp[1]] = payload;
	}
	return { boundary, fields, files };
}

const server = http.createServer((req, res) => {
	if (req.url === "/favicon.ico") {
		res.writeHead(200, { "Content-Type": "image/x-icon" });
		res.end(Buffer.from([0, 0, 1, 0, 1, 2, 3, 4]));
		return;
	}
	if (req.url === "/.env") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("APP_KEY=base64:fixture\nDB_PASSWORD=secret\n");
		return;
	}
	if (req.url === "/.git/config") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("[core]\n\trepositoryformatversion = 0\n");
		return;
	}
	if (req.url === "/openapi.json") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			openapi: "3.0.0",
			info: { title: "Fixture", version: "1" },
			servers: [{ url: "/" }],
			paths: {
				"/api/from-openapi/{id}": {
					get: {
						operationId: "listOpenapi",
						parameters: [
							{ name: "id", in: "path", required: true, schema: { type: "string" } },
							{ name: "expand", in: "query", schema: { type: "boolean" } },
							{ name: "x-trace", in: "header", schema: { type: "string" } },
						],
					},
				},
				"/api/from-openapi-post": {
					post: {
						operationId: "postOpenapi",
						requestBody: {
							required: true,
							content: {
								"application/json": {
									schema: {
										type: "object",
										required: ["role"],
										properties: {
											role: { type: "string" },
											meta: { type: "object", properties: { enabled: { type: "boolean" } } },
										},
									},
								},
							},
						},
					},
				},
			},
		}));
		return;
	}
	if (req.url === "/template-dsl") {
		res.writeHead(200, { "Content-Type": "application/json", "X-Template-Fixture": "dsl-ok" });
		res.end(JSON.stringify({ ok: true, token: "dsl-token", nested: { value: "json-hit" } }));
		return;
	}
	if (req.url === "/manifest.json") {
		res.writeHead(200, { "Content-Type": "application/manifest+json" });
		res.end(JSON.stringify({ name: "Fixture App", start_url: "/" }));
		return;
	}
	if (req.url === "/sw.js") {
		res.writeHead(200, { "Content-Type": "application/javascript" });
		res.end("self.addEventListener('install', event => event.waitUntil(caches.open('v1').then(cache => cache.addAll(['/offline', '/api/from-sw'])))); self.addEventListener('fetch', () => {});\n//# sourceMappingURL=/sw.js.map");
		return;
	}
	if (req.url === "/static/app.js.map" || req.url === "/sw.js.map") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ version: 3, sources: ["app.ts", "/api/from-source-name"], sourcesContent: ["fetch('/api/from-map');", ""], mappings: "" }));
		return;
	}
	if (req.url?.startsWith("/graphql")) {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const query = (() => {
				try {
					const parsed = JSON.parse(body || "{}");
					return typeof parsed.query === "string" ? parsed.query : "";
				} catch {
					return body;
				}
			})();
			res.writeHead(200, { "Content-Type": "application/json" });
			if (req.method === "POST" && query.includes("__schema")) {
				res.end(JSON.stringify({
					data: {
						__schema: {
							queryType: { name: "Query" },
							mutationType: { name: "Mutation" },
							types: [
								{ name: "Query", fields: [{ name: "viewer", args: [{ name: "id" }] }] },
								{ name: "Mutation", fields: [{ name: "login", args: [{ name: "user" }] }] },
							],
						},
					},
				}));
				return;
			}
			res.end(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }));
		});
		return;
	}
	if (req.url?.startsWith("/sqli")) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const id = url.searchParams.get("id") || "";
		const write = (status, body) => {
			res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<html><head><title>SQLi</title></head><body>${body}</body></html>`);
		};
		const order = id.match(/ORDER\s+BY\s+(\d+)/i);
		if (order) {
			write(Number(order[1]) <= 2 ? 200 : 500, Number(order[1]) <= 2 ? "row alice" : "Unknown column in order clause");
			return;
		}
		const union = id.match(/UNION\s+SELECT\s+([^\-#]+)/i);
		if (union) {
			const cols = union[1].split(",").map((item) => item.trim()).filter(Boolean).length;
			write(cols === 2 ? 200 : 500, cols === 2 ? `union-visible ${union[1]}` : "The used SELECT statements have a different number of columns");
			return;
		}
		const blind = id.match(/ASCII\s*\(\s*SUBSTRING\s*\(\s*\(([^)]*)\)\s*,\s*(\d+)\s*,\s*1\s*\)\s*\)\s*=\s*(\d+)/i);
		if (blind) {
			const secret = "ok";
			write(Number(blind[3]) === secret.charCodeAt(Number(blind[2]) - 1) ? 200 : 200, Number(blind[3]) === secret.charCodeAt(Number(blind[2]) - 1) ? "row alice" : "no rows");
			return;
		}
		if (/sleep|pg_sleep|waitfor/i.test(id)) {
			setTimeout(() => write(200, "row alice"), 140);
			return;
		}
		if (id.includes("1=2")) {
			write(200, "no rows");
			return;
		}
		if (id.includes("1=1") || id === "1") {
			write(200, "row alice");
			return;
		}
		if (/["'`]/.test(id)) {
			write(500, "You have an error in your SQL syntax near quote");
			return;
		}
		write(200, "no rows");
		return;
	}
	if (req.url === "/vhost") {
		const host = String(req.headers.host || "");
		if (host === "admin.fixture.test") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><head><title>Admin VHost</title></head><body>admin vhost</body></html>");
		} else {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("baseline vhost miss");
		}
		return;
	}
	if (req.url === "/multi/admin/view") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<html><head><title>Multi</title></head><body>multi fuzz hit</body></html>");
		return;
	}
	if (req.url?.startsWith("/multi/")) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("multi miss");
		return;
	}
	if (req.url === "/recursive/admin") {
		res.writeHead(302, { Location: "/recursive/admin/" });
		res.end("redirect");
		return;
	}
	if (req.url === "/recursive/admin/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<html><head><title>Recursive Admin</title></head><body>recursive admin</body></html>");
		return;
	}
	if (req.url === "/recursive/admin/panel") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<html><head><title>Recursive Panel</title></head><body>recursive panel</body></html>");
		return;
	}
	if (req.url?.startsWith("/recursive/")) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("recursive miss");
		return;
	}
	if (req.url === "/cluster/known") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<html><head><title>Cluster Real</title></head><body>cluster hit</body></html>");
		return;
	}
	if (req.url?.startsWith("/cluster/")) {
		const slug = req.url.slice("/cluster/".length) || "missing";
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<html><head><title>Wildcard Cluster</title></head><body>miss:${slug}</body></html>`);
		return;
	}
	if (req.url === "/redirect") {
		res.writeHead(302, { Location: "/final", "X-Powered-By": "Express", "Set-Cookie": "session=secret; HttpOnly" });
		res.end("redirect");
		return;
	}
	if (req.url === "/final") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Powered-By": "Express" });
		res.end("<html><head><title>Final</title></head><body>done</body></html>");
		return;
	}
	if (req.url === "/robots.txt") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end(`User-agent: *\nDisallow: /private\nSitemap: http://${req.headers.host}/sitemap.xml\n`);
		return;
	}
	if (req.url === "/sitemap.xml") {
		res.writeHead(200, { "Content-Type": "application/xml" });
		res.end(`<?xml version="1.0"?><urlset><url><loc>http://${req.headers.host}/from-sitemap</loc></url></urlset>`);
		return;
	}
	if (req.url === "/next" || req.url === "/from-sitemap" || req.url === "/admin" || req.url === "/admin.php") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
		return;
	}
	if (req.url === "/static/app.js") {
		res.writeHead(200, { "Content-Type": "application/javascript" });
		res.end("fetch('/api/hidden'); fetch('/graphql', {method:'POST'}); navigator.serviceWorker.register('/sw.js'); const admin = '/admin';\n//# sourceMappingURL=/static/app.js.map");
		return;
	}
	if (req.url === "/api/hidden" || req.url === "/api/from-openapi-post" || req.url?.startsWith("/api/from-openapi/")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
	if (req.url?.startsWith("/param")) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		if (url.searchParams.get("debug") === "1") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("debug enabled");
		} else {
			res.writeHead(403, { "Content-Type": "text/plain" });
			res.end("blocked");
		}
		return;
	}
	if (req.url === "/json") {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const parsed = JSON.parse(body || "{}");
			const role = [parsed.role, parsed.user?.role, parsed.users?.[0]?.role].includes("admin") ? "admin" : (parsed.role || parsed.user?.role || parsed.users?.[0]?.role || null);
			res.writeHead(role === "admin" || parsed.meta?.enabled === true ? 201 : 403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ role, meta: parsed.meta || null, keys: Object.keys(parsed) }));
		});
		return;
	}
	if (req.url === "/form") {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(form.get("role") === "admin" ? 202 : 403, { "Content-Type": "text/plain" });
			res.end(form.get("role") || "none");
		});
		return;
	}
	if (req.url === "/multipart") {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const parsed = parseMultipartFixture(body, String(req.headers["content-type"] || ""));
			if (parsed.error) {
				res.writeHead(415, { "Content-Type": "application/json" });
				res.end(JSON.stringify(parsed));
				return;
			}
			if (!Object.keys(parsed.fields).length && !parsed.files.length) {
				res.writeHead(422, { "Content-Type": "application/json" });
				res.end(JSON.stringify(parsed));
				return;
			}
			const uploads = parsed.files.filter((item) => item.name === "upload");
			const file = uploads.find((item) => item.filename === "a.txt" && item.content.includes("hello"));
			const okField = parsed.fields.role === "admin";
			const okFile = file && file.filename === "a.txt" && file.content.includes("hello");
			const okMultiFile = uploads.length === 2 && uploads.some((item) => item.filename === "a.txt" && item.content.includes("alpha")) && uploads.some((item) => item.filename === "b.txt" && item.content.includes("beta"));
			const okNestedMultipart = uploads.some((item) => /^multipart\/form-data; boundary=/i.test(String(item.contentType || "")) && item.content.includes('name="innerRole"') && item.content.includes('name="innerUpload"') && item.content.includes("inner.txt") && item.content.includes("inside"));
			res.writeHead(okNestedMultipart ? 207 : okMultiFile ? 206 : okFile ? 201 : okField ? 200 : 403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ fields: parsed.fields, files: parsed.files, boundary: parsed.boundary, header: req.headers["content-type"] }));
		});
		return;
	}
	if (req.url === "/header") {
		res.writeHead(req.headers["x-debug"] === "yes" ? 204 : 403, { "Content-Type": "text/plain" });
		res.end(req.headers["x-debug"] === "yes" ? "" : "blocked");
		return;
	}
	if (req.url === "/set-cookie") {
		res.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "flow=ok; Path=/" });
		res.end("cookie set");
		return;
	}
	if (req.url === "/cookie-check") {
		res.writeHead(String(req.headers.cookie || "").includes("flow=ok") ? 200 : 403, { "Content-Type": "text/plain" });
		res.end(String(req.headers.cookie || ""));
		return;
	}
	if (req.url === "/claims") {
		const token = String(req.headers.cookie || "").split(/;\s*/).map((item) => item.split("=")).find((item) => item[0] === "fixture_jwt")?.slice(1).join("=") || "";
		const payload = jwtPayload(token) || {};
		res.writeHead(payload.role === "admin" ? 200 : 403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ role: payload.role || null }));
		return;
	}
	if (req.url === "/issue-token") {
		res.writeHead(200, { "Content-Type": "application/json", "X-Flow-Token": "hdr-123" });
		res.end(JSON.stringify({ token: "seq-abc" }));
		return;
	}
	if (req.url?.startsWith("/use-token")) {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const url = new URL(req.url, `http://${req.headers.host}`);
			const body = Buffer.concat(chunks).toString("utf8");
			const ok = url.searchParams.get("token") === "seq-abc" && req.headers["x-flow-token"] === "hdr-123" && body.includes("seq-abc");
			res.writeHead(ok ? 200 : 403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok, body, token: url.searchParams.get("token"), header: req.headers["x-flow-token"] }));
		});
		return;
	}
	if (req.url === "/cluster-a" || req.url === "/cluster-b") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("cluster-same");
		return;
	}
	if (req.url === "/cluster-c") {
		res.writeHead(201, { "Content-Type": "text/plain" });
		res.end("cluster-diff");
		return;
	}
	if (req.url === "/echo") {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			const body = Buffer.concat(chunks);
			res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8"), bodyBase64: body.toString("base64") }));
		});
		return;
	}
	if (req.url === "/") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Powered-By": "Express", "Set-Cookie": "session=secret; HttpOnly" });
		res.end("<html><head><title>Home</title><link rel='manifest' href='/manifest.json'></head><body><a href='/next'>Next</a><form method='post' action='/echo'><input name='q'></form><script src='/static/app.js'></script><script>const endpoint='/api/inline';</script>Hello</body></html>");
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const defaultSecureContext = createSecureContext({ key: DEFAULT_HTTPS_KEY_PEM, cert: DEFAULT_HTTPS_CERT_PEM });
const adminSecureContext = createSecureContext({ key: ALT_HTTPS_KEY_PEM, cert: ALT_HTTPS_CERT_PEM });
const httpsServer = https.createServer({
	key: DEFAULT_HTTPS_KEY_PEM,
	cert: DEFAULT_HTTPS_CERT_PEM,
	SNICallback(servername, callback) {
		const context = servername === "admin.fixture.test" ? adminSecureContext : defaultSecureContext;
		if (typeof callback === "function") callback(null, context);
		else return context;
	},
}, (req, res) => {
	if (req.url === "/vhost") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end("<html><head><title>Secure Wildcard</title></head><body>secure wildcard</body></html>");
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("missing");
});
await new Promise((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
try {
	const address = server.address();
	const httpsAddress = httpsServer.address();
	assert(address && typeof address === "object", "expected listen address");
	assert(httpsAddress && typeof httpsAddress === "object", "expected https listen address");
	const base = `http://127.0.0.1:${address.port}`;
	const secureBase = `https://127.0.0.1:${httpsAddress.port}`;

	const recon = await runReconProbe({ url: base, paths: ["/", "/redirect"], followRedirects: true, maxRedirects: 3, includeFaviconHash: true, includeTlsCertificate: true, maxBodyBytes: 64_000 });
	assert.equal(recon.ok, true, "recon should succeed for both scoped paths");
	assert.equal(recon.count, 2);
	assert.equal(recon.results[0].title, "Home");
	assert.ok(recon.results[0].tech.some((item) => String(item).includes("Express")), "recon should report header tech hints");
	assert.ok(recon.results[0].techHints.some((item) => item.source === "header" && item.name === "x-powered-by" && item.label === "Express"), "recon should expose structured tech hints");
	assert.ok(recon.results[0].fingerprints.some((item) => item.category === "framework" && item.label === "Express"), "recon should expose structured fingerprint records");
	assert.equal(recon.results[1].title, "Final");
	assert.equal(recon.results[1].redirects.length, 1, "recon should store redirect chain");
	assert.match(recon.results[0].body.sha256, /^[a-f0-9]{64}$/, "recon should hash response body");
	assert.match(recon.results[0].favicon.sha256, /^[a-f0-9]{64}$/, "recon should hash favicon when requested");
	assert.match(String(recon.results[0].favicon.mmh3), /^-?\d+$/, "recon should compute favicon mmh3 when requested");
	assert.match(recon.results[0].favicon.simHash64, /^[a-f0-9]{16}$/i, "recon should compute a favicon similarity hash when requested");
	assert.equal(recon.results[0].tlsCertificate, undefined, "recon should skip TLS metadata on http URLs");
	const expandedRecon = await runReconProbe({ url: "127.0.0.1", schemes: ["http"], ports: [address.port], paths: ["/"], maxBodyBytes: 64_000 });
	assert.equal(expandedRecon.count, 1, "recon should expand host-only scheme/port targets");
	assert.equal(expandedRecon.results[0].title, "Home");
	const reconSummary = summarizeWebReconProbeData(recon);
	assert.ok(reconSummary.results.rows.some((row) => row.some((cell) => String(cell).includes("Express"))), "recon summary should expose fingerprint previews");
	assert.equal(JSON.stringify(reconSummary).includes("session=secret"), false, "recon summary must not leak Set-Cookie values");

	const crawl = await runBrowserCrawl({ url: base, knownFiles: "all", maxDepth: 2, maxPages: 50, maxBodyBytes: 64_000 });
	assert.equal(crawl.ok, true, "crawl should complete scoped fixture");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/next`), "crawl should follow same-origin links");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/robots.txt`), "crawl should include known files");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/from-sitemap`), "crawl should follow sitemap loc entries");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/api/hidden`), "crawl should extract JS fetch endpoints");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/graphql` && endpoint.kind === "graphql" && endpoint.method === "POST"), "crawl should extract GraphQL fetch semantics");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/manifest.json` && endpoint.kind === "manifest"), "crawl should extract manifest links");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/sw.js` && endpoint.kind === "service-worker"), "crawl should extract service worker registrations");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/static/app.js.map` && endpoint.kind === "source-map"), "crawl should extract source map hints");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/openapi.json` && page.apiSpec?.kind === "openapi"), "crawl should identify OpenAPI documents");
	assert.ok(crawl.endpoints.some((endpoint) => String(endpoint.url).includes("/api/from-openapi/") && endpoint.kind === "api-endpoint" && endpoint.method === "GET"), "crawl should expand OpenAPI endpoints");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/openapi.json` && page.apiSpec?.parameterSummary?.pathCount === 1 && page.apiSpec?.parameterSummary?.queryCount === 1 && page.apiSpec?.parameterSummary?.headerCount === 1), "crawl should summarize OpenAPI parameter locations");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/openapi.json` && page.apiSpec?.parameterSummary?.requestBodyFields?.some((field) => field.path === "role") && page.apiSpec?.parameterSummary?.requestBodyFields?.some((field) => field.path === "meta.enabled")), "crawl should summarize OpenAPI request body schema fields");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/api/from-openapi-post` && endpoint.parameterSummary?.requestBodyFieldCount === 2), "crawl should attach OpenAPI request body summaries to endpoints");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/graphql` && page.graphqlSchema?.source === "active-probe" && page.graphqlSchema?.queryFields?.some((field) => field.name === "viewer")), "crawl should actively probe GraphQL introspection when passive responses omit schema");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/sw.js` && page.serviceWorkerDetails?.cacheRoutes?.some((route) => route.url === `${base}/api/from-sw`)), "crawl should extract service worker cache routes");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/sw.js` && page.serviceWorkerDetails?.versionSummary?.cacheNames?.includes("v1") && page.serviceWorkerDetails?.versionSummary?.versionTokens?.includes("v1")), "crawl should summarize service worker cache versions");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/static/app.js.map` && page.sourceMapDetails?.endpointHints?.some((endpoint) => endpoint.url === `${base}/api/from-map`)), "crawl should parse source map sourcesContent endpoint hints");
	assert.ok(crawl.pages.some((page) => page.url === `${base}/static/app.js.map` && page.sourceMapDetails?.archivedSourceCount >= 1), "crawl should archive reverse source-map sources");
	assert.ok(crawl.sourceArchiveCount >= 1, "crawl should expose aggregate source archive counts");
	assert.ok(crawl.serviceWorkerVersionTokens?.includes("v1"), "crawl should expose aggregate service worker version tokens");
	const archivedSource = crawl.pages.find((page) => page.url === `${base}/static/app.js.map`)?.sourceMapDetails?.archivedSources?.find((item) => item.sourceName === "app.ts");
	assert.ok(archivedSource?.relativePath && crawl.artifactRoot, "crawl should expose archived source relative paths and artifact root");
	const archivedSourceText = await readFile(path.join(crawl.artifactRoot, archivedSource.relativePath), "utf8");
	assert.match(archivedSourceText, /fetch\('\/api\/from-map'\)/, "crawl should write archived source-map file contents");
	assert.ok(crawl.endpoints.some((endpoint) => endpoint.url === `${base}/echo` && endpoint.kind === "form"), "crawl should inventory form actions");
	const crawlSummary = summarizeBrowserCrawlData(crawl);
	assert.equal(crawlSummary.pageCount, crawl.pages.length, "crawl summary should expose page count");
	assert.equal(crawlSummary.sourceArchiveCount, crawl.sourceArchiveCount, "crawl summary should expose source archive counts");
	assert.ok(crawlSummary.serviceWorkerVersionTokens?.includes("v1"), "crawl summary should expose service worker version tokens");
	assert.equal(JSON.stringify(crawlSummary).includes("session=secret"), false, "crawl summary must not leak cookie values");

	const fuzz = await runFuzzPaths({ url: base, words: ["admin", "missing", "api/hidden"], extensions: ["php"], matchStatus: [200], filterStatus: [404], maxCandidates: 20, maxBodyBytes: 64_000 });
	assert.equal(fuzz.ok, true, "path fuzz should complete fixture");
	assert.equal(fuzz.requestCount, 6, "path fuzz should expand extension variants");
	assert.ok(fuzz.matched.some((item) => item.url === `${base}/admin`), "path fuzz should match discovered route");
	assert.ok(fuzz.matched.some((item) => item.url === `${base}/admin.php`), "path fuzz should match extension route");
	assert.ok(fuzz.matched.some((item) => item.url === `${base}/api/hidden`), "path fuzz should match nested route");
	assert.equal(fuzz.matched.some((item) => item.url === `${base}/missing`), false, "path fuzz should filter 404 route");
	const fuzzSummary = summarizeFuzzPathsData(fuzz);
	assert.equal(fuzzSummary.matchedCount, fuzz.matched.length, "fuzz summary should expose matched count");
	assert.ok(Array.isArray(fuzz.clusters) && fuzz.clusters.length >= 1, "path fuzz should cluster response fingerprints");
	assert.ok(fuzz.baselines.every((item) => typeof item.bodySha256 === "string" || item.error), "path fuzz should record auto baselines");
	assert.equal(JSON.stringify(fuzzSummary).includes("session=secret"), false, "fuzz summary must not leak cookie values");

	const multiFuzz = await runFuzzPaths({ url: `${base}/multi/FUZZ/FUZZ`, words: ["admin::view", "missing::view"], matchStatus: [200], filterStatus: [404], filterBaseline: true, maxCandidates: 5, maxBodyBytes: 64_000 });
	assert.equal(multiFuzz.matchedCount, 1, "path fuzz should support multiple FUZZ token tuples");
	assert.equal(multiFuzz.matched[0].url, `${base}/multi/admin/view`);
	assert.equal(multiFuzz.matched[0].differentFromBaseline, true);

	const recursiveFuzz = await runFuzzPaths({ url: `${base}/recursive`, words: ["admin", "panel", "missing"], appendSlash: true, recursive: true, maxDepth: 2, matchStatus: [200], filterStatus: [404], filterBaseline: true, maxCandidates: 20, maxBodyBytes: 64_000 });
	assert.equal(recursiveFuzz.recursive, true, "path fuzz should expose recursive mode");
	assert.equal(recursiveFuzz.maxDepth, 2, "path fuzz should preserve recursive depth limit");
	assert.ok(recursiveFuzz.visitedBaseCount >= 2, "path fuzz should revisit discovered directory bases");
	assert.ok(recursiveFuzz.discoveredDirectoryCount >= 1, "path fuzz should report discovered directories");
	assert.ok(recursiveFuzz.matched.some((item) => item.url === `${base}/recursive/admin/panel` && item.depth === 2), "path fuzz should recursively discover deeper routes");

	const clusteredFuzz = await runFuzzPaths({ url: `${base}/cluster`, words: ["known", "ghost", "longghost"], matchStatus: [200], filterBaseline: true, baselineStrategy: "cluster", maxCandidates: 10, maxBodyBytes: 64_000 });
	assert.equal(clusteredFuzz.matchedCount, 1, "path fuzz should filter wildcard misses with baseline clustering");
	assert.equal(clusteredFuzz.matched[0].url, `${base}/cluster/known`);
	assert.ok(clusteredFuzz.results.some((item) => item.url === `${base}/cluster/ghost` && item.baselineClusterMatched === true && item.matched === false), "path fuzz should mark clustered baseline misses");
	assert.ok(clusteredFuzz.baselineClusters.length >= 1, "path fuzz should expose clustered baseline summaries");

	const vhosts = await runFuzzVhosts({ url: `${base}/vhost`, hosts: ["admin.fixture.test", "missing.fixture.test"], matchStatus: [200], filterStatus: [404], maxCandidates: 5, maxBodyBytes: 64_000 });
	assert.equal(vhosts.ok, true, "vhost fuzz should complete fixture");
	assert.equal(vhosts.matchedCount, 1, "vhost fuzz should find one differentiated host");
	assert.equal(vhosts.matched[0].host, "admin.fixture.test");
	assert.equal(vhosts.matched[0].title, "Admin VHost");
	assert.equal(vhosts.matched[0].differentFromBaseline, true);
	assert.match(vhosts.matched[0].bodySha256, /^[a-f0-9]{64}$/, "vhost fuzz should hash response bodies");
	assert.ok(vhosts.clusters.some((cluster) => cluster.hosts.includes("admin.fixture.test")), "vhost fuzz should cluster host responses");
	const hostSni = await runFuzzVhosts({ url: `${base}/vhost`, hosts: ["admin.fixture.test"], sniMode: "host", baselineHosts: ["baseline-one.fixture.test", "baseline-two.fixture.test"], matchStatus: [200], filterStatus: [404], maxCandidates: 5, maxBodyBytes: 64_000 });
	assert.equal(hostSni.matched[0].sniName, "admin.fixture.test", "vhost fuzz should support Host-as-SNI mode");
	assert.ok(hostSni.baselines.length >= 2, "vhost fuzz should support multiple baseline hosts");
	const httpsVhosts = await runFuzzVhosts({ url: `${secureBase}/vhost`, hosts: ["admin.fixture.test", "missing.fixture.test"], sniMode: "host", baselineHosts: ["baseline-one.fixture.test", "baseline-two.fixture.test"], matchStatus: [200], filterBaseline: true, baselineStrategy: "cluster", maxCandidates: 5, maxBodyBytes: 64_000 });
	assert.equal(httpsVhosts.ok, true, "vhost fuzz should support HTTPS fixtures");
	assert.equal(httpsVhosts.matchedCount, 1, "vhost fuzz should treat certificate-differentiated hosts as matches");
	assert.equal(httpsVhosts.matched[0].host, "admin.fixture.test");
	assert.equal(httpsVhosts.matched[0].sniName, "admin.fixture.test", "vhost fuzz should preserve host-based SNI on HTTPS fixtures");
	assert.match(httpsVhosts.matched[0].tlsFingerprint256, /:/, "vhost fuzz should capture peer certificate fingerprints");
	assert.equal(httpsVhosts.matched[0].certificateDelta.fingerprintChanged, true, "vhost fuzz should detect certificate differences from the nearest baseline");
	assert.ok(httpsVhosts.results.some((item) => item.host === "missing.fixture.test" && item.baselineClusterMatched === true && item.matched === false), "vhost fuzz should filter clustered HTTPS baseline responses");
	assert.ok(httpsVhosts.baselineClusters.length >= 1, "vhost fuzz should expose baseline certificate clusters");
	const vhostSummary = summarizeFuzzVhostsData(httpsVhosts);
	assert.equal(vhostSummary.matchedCount, 1, "vhost summary should expose matched count");
	assert.ok(vhostSummary.matched.rows.some((row) => row.some((cell) => String(cell).includes("admin.fixture.test"))), "vhost summary should include matched HTTPS hosts");

	const fixtureJwt = hs256Jwt({ sub: "alice", role: "user", iat: 1 }, "secret");
	const fixtureJweSecret = "0123456789abcdef0123456789abcdef";
	const fixtureJwe = directJwe({ sub: "alice", role: "user" }, fixtureJweSecret);
	const fixturePaseto = pasetoFixture();
	const fixtureDjango = djangoSigned({ sub: "alice", role: "user" }, "secret");
	const fixtureFlask = flaskSigned({ sub: "alice", role: "user" }, "secret");
	const fixtureRails = railsSigned({ sub: "alice", role: "user" }, "secret");
	const cookieAnalysis = await runCookieAnalyze({
		cookies: [
			`session=${fixtureJwt}; HttpOnly; Path=/`,
			"prefs=%7B%22theme%22%3A%22dark%22%7D",
			`jwe=${fixtureJwe}`,
			`paseto=${fixturePaseto}`,
			`django=${fixtureDjango}`,
			`flask=${fixtureFlask}`,
			`rails=${fixtureRails}`,
		],
		secretCandidates: ["wrong", "secret", fixtureJweSecret],
		claimMutations: { role: "admin" },
	});
	assert.equal(cookieAnalysis.ok, true, "cookie analyze should complete fixture");
	assert.equal(cookieAnalysis.cookieCount, 7, "cookie analyze should parse cookie pairs");
	assert.equal(cookieAnalysis.tokenCount, 6, "cookie analyze should count structured token formats");
	assert.equal(cookieAnalysis.jwtCount, 1, "cookie analyze should detect JWT");
	assert.equal(cookieAnalysis.jweCount, 1, "cookie analyze should detect JWE");
	assert.equal(cookieAnalysis.pasetoCount, 1, "cookie analyze should detect PASETO");
	assert.equal(cookieAnalysis.sessionFormatCount, 3, "cookie analyze should detect Django/Flask/Rails session formats");
	assert.equal(cookieAnalysis.verifiedJwtCount, 1, "cookie analyze should verify HS256 candidate");
	assert.equal(cookieAnalysis.verifiedTokenCount, 5, "cookie analyze should verify every supported signed token fixture");
	assert.equal(cookieAnalysis.mutationCount, 5, "cookie analyze should generate mutations for replayable structured payloads");
	const analyzedJwt = cookieAnalysis.results.find((item) => item.name === "session")?.jwt;
	assert.equal(analyzedJwt.payload.role, "user");
	assert.equal(analyzedJwt.signature.matches[0].secret, "secret");
	assert.match(analyzedJwt.mutation.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	const analyzedJwe = cookieAnalysis.results.find((item) => item.name === "jwe")?.jwe;
	assert.equal(analyzedJwe.payload.role, "user", "cookie analyze should decrypt supported JWE payloads");
	assert.equal(analyzedJwe.decryption.matches[0].secret, fixtureJweSecret, "cookie analyze should match JWE direct secrets");
	assert.match(analyzedJwe.mutation.token, /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "cookie analyze should emit mutated compact JWE tokens");
	const analyzedPaseto = cookieAnalysis.results.find((item) => item.name === "paseto")?.paseto;
	assert.equal(analyzedPaseto.version, "v4", "cookie analyze should expose PASETO version metadata");
	assert.equal(analyzedPaseto.purpose, "local", "cookie analyze should expose PASETO purpose metadata");
	assert.equal(analyzedPaseto.footer.kid, "fixture-paseto", "cookie analyze should decode PASETO footers when printable");
	const analyzedDjango = cookieAnalysis.results.find((item) => item.name === "django")?.sessionToken;
	assert.equal(analyzedDjango.signature.verified, true, "cookie analyze should verify Django signed sessions");
	assert.equal(analyzedDjango.payload.role, "user");
	assert.match(analyzedDjango.mutation.token, /:/, "cookie analyze should mutate Django signed sessions");
	const analyzedFlask = cookieAnalysis.results.find((item) => item.name === "flask")?.sessionToken;
	assert.equal(analyzedFlask.signature.verified, true, "cookie analyze should verify Flask signed sessions");
	assert.equal(analyzedFlask.payload.role, "user");
	assert.match(analyzedFlask.mutation.token, /\./, "cookie analyze should mutate Flask signed sessions");
	const analyzedRails = cookieAnalysis.results.find((item) => item.name === "rails")?.sessionToken;
	assert.equal(analyzedRails.signature.verified, true, "cookie analyze should verify Rails signed sessions");
	assert.equal(analyzedRails.payload.role, "user");
	assert.match(analyzedRails.mutation.token, /--/, "cookie analyze should mutate Rails signed sessions");
	const analyzedPrefs = cookieAnalysis.results.find((item) => item.name === "prefs");
	assert.equal(analyzedPrefs.kind, "encoded-json");
	const claimReplayAnalysis = await runCookieAnalyze({
		url: `${base}/claims`,
		bindBrowserSession: true,
		cookieProvider: async () => `fixture_jwt=${fixtureJwt}; theme=dark`,
		secretCandidates: ["secret"],
		claimMutations: { role: "admin" },
		claimReplay: { url: `${base}/claims`, matchStatus: [200], maxCases: 2 },
	});
	assert.equal(claimReplayAnalysis.claimReplayCount, 1, "cookie analyze should run one bounded claim replay against browser-session cookies");
	assert.equal(claimReplayAnalysis.claimReplayFailureCount, 0, "cookie analyze should avoid replay failures for supported fixtures");
	assert.equal(claimReplayAnalysis.claimReplays[0].baseline.status, 403, "claim replay should keep the original browser-session claim in the baseline request");
	assert.equal(claimReplayAnalysis.claimReplays[0].mutated.status, 200, "claim replay should inject the mutated claim token into the replay request");
	assert.ok(claimReplayAnalysis.claimReplays[0].delta.classifier.includes("status"), "claim replay should surface response deltas");
	const replayedCookie = claimReplayAnalysis.results.find((item) => item.name === "fixture_jwt");
	assert.equal(replayedCookie.claimReplay.matchedStatus, true, "claim replay should expose status matching results per token");
	const cookieSummary = summarizeCookieAnalyzeData(claimReplayAnalysis);
	assert.equal(cookieSummary.jwtCount, 1, "cookie summary should expose JWT count");
	assert.equal(cookieSummary.claimReplayCount, 1, "cookie summary should expose claim replay counts");

	const sqli = await runSqliProbe({ url: `${base}/sqli?id=1`, locations: ["query"], paramNames: ["id"], probeTypes: ["boolean", "error", "time"], timePayloads: ["' AND SLEEP(5)--"], timeThresholdMs: 80, maxCases: 20, timeoutMs: 2_000, maxBodyBytes: 64_000 });
	assert.equal(sqli.ok, true, "sqli probe should complete fixture");
	assert.ok(sqli.matched.some((item) => item.type === "boolean"), "sqli probe should classify boolean oracle");
	assert.ok(sqli.matched.some((item) => item.type === "error"), "sqli probe should classify error oracle");
	assert.ok(sqli.matched.some((item) => item.type === "time"), "sqli probe should classify time oracle");
	assert.ok(sqli.dbmsFingerprints.includes("mysql"), "sqli probe should infer DBMS fingerprints from errors");
	const sqliUnion = await runSqliProbe({ url: `${base}/sqli?id=1`, locations: ["query"], paramNames: ["id"], probeTypes: ["union"], orderByMax: 3, unionColumnMax: 3, maxCases: 20, timeoutMs: 2_000, maxBodyBytes: 64_000 });
	assert.ok(sqliUnion.columnHints.some((hint) => hint.paramName === "id" && hint.orderByMaxValid === 2), "sqli probe should infer ORDER BY column count hints");
	assert.ok(sqliUnion.columnHints.some((hint) => hint.paramName === "id" && hint.unionSelectColumns === 2), "sqli probe should infer UNION SELECT column count hints");
	assert.ok(sqliUnion.echoPositions.some((item) => item.paramName === "id" && item.position === 1), "sqli probe should enumerate UNION echo positions");
	assert.ok(sqliUnion.echoPositions.some((item) => item.paramName === "id" && item.position === 2), "sqli probe should enumerate all reflected UNION columns");
	const blindExtract = await runSqliProbe({ url: `${base}/sqli?id=1`, locations: ["query"], paramNames: ["id"], probeTypes: ["boolean"], extractExpression: "secret", extractMaxLength: 2, extractCharset: "okx", dbms: "mysql", maxCases: 30, timeoutMs: 2_000, maxBodyBytes: 64_000 });
	assert.equal(blindExtract.dbmsPayloadPack[0], "mysql", "sqli probe should expose selected DBMS payload pack");
	assert.equal(blindExtract.extractions[0].value, "ok", "sqli probe should run boolean-blind extraction loops");
	const sqliSummary = summarizeSqliProbeData(sqliUnion);
	assert.equal(sqliSummary.matchedCount, sqliUnion.matched.length, "sqli summary should expose matched count");
	assert.equal(sqliSummary.columnHints.count, sqliUnion.columnHints.length, "sqli summary should expose column hints");

	const fakeSqlmapPath = ".pi/browser-artifacts/fake-sqlmap-fixture.mjs";
	await writeFile(fakeSqlmapPath, String.raw`import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const valueOf = (name) => { const index = args.indexOf(name); if (index >= 0 && index + 1 < args.length) return args[index + 1]; const pair = args.find((item) => item.startsWith(name + "=")); return pair ? pair.slice(name.length + 1) : undefined; };
const requestFile = valueOf("-r");
const outputDir = valueOf("--output-dir") || process.cwd();
const requestText = requestFile ? await readFile(requestFile, "utf8") : "";
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "log"), "fake sqlmap log", "utf8");
console.log("[INFO] sqlmap resumed the following injection point(s) from stored session:");
console.log("---");
console.log("Parameter: id (GET)");
console.log("    Type: boolean-based blind");
console.log("    Title: AND boolean-based blind - WHERE or HAVING clause");
console.log("    Payload: id=1 AND 1=1");
console.log("    Cookie: session=secret");
console.log("");
console.log("back-end DBMS: MySQL >= 5.0");
console.log("web server operating system: Linux");
console.log("web application technology: Express");
console.log("current user: 'root@localhost'");
console.log("current database: 'fixture'");
console.log("current user is DBA: True");
console.log(requestText.includes("Cookie:") ? "request cookie observed" : "request cookie missing");
`, "utf8");
	const sqlmapBridge = await runSqlmapBridge({ rawRequest: `GET /sqli?id=1 HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nCookie: stale=1\r\n\r\n`, defaultScheme: "http", bindBrowserSession: true, cookieMode: "merge", cookieProvider: async () => "sid=abc", sqlmapPath: process.execPath, sqlmapArgs: [fakeSqlmapPath], paramNames: ["id"], dbms: "mysql", currentDb: true, currentUser: true, isDba: true, timeoutMs: 10_000 });
	assert.equal(sqlmapBridge.ok, true, "sqlmap bridge should complete fixture");
	assert.equal(sqlmapBridge.runCount, 1, "sqlmap bridge should execute one target by default");
	assert.equal(sqlmapBridge.findingCount, 1, "sqlmap bridge should parse one finding");
	assert.equal(sqlmapBridge.vulnerableRunCount, 1, "sqlmap bridge should report vulnerable runs");
	assert.ok(sqlmapBridge.dbmsFingerprints.includes("MySQL >= 5.0"), "sqlmap bridge should parse DBMS fingerprints");
	assert.equal(sqlmapBridge.currentUsers[0], "root@localhost", "sqlmap bridge should parse current user metadata");
	assert.equal(sqlmapBridge.currentDatabases[0], "fixture", "sqlmap bridge should parse current database metadata");
	assert.equal(sqlmapBridge.runs[0].isDba, true, "sqlmap bridge should parse DBA metadata");
	assert.equal(sqlmapBridge.findings[0].parameter, "id", "sqlmap bridge should parse finding parameter names");
	const sqlmapRequestText = await readFile(sqlmapBridge.runs[0].requestFile, "utf8");
	assert.match(sqlmapRequestText, /Cookie: stale=1; sid=abc|Cookie: sid=abc; stale=1/, "sqlmap bridge should merge browser-session cookies into the request file");
	const sqlmapSummary = summarizeSqlmapBridgeData(sqlmapBridge);
	assert.equal(sqlmapSummary.findingCount, 1, "sqlmap bridge summary should expose finding count");
	assert.equal(JSON.stringify(sqlmapSummary).includes("session=secret"), false, "sqlmap bridge summary must redact sensitive preview text");

	const fakeNucleiPath = ".pi/browser-artifacts/fake-nuclei-fixture.mjs";
	const fakeNucleiTemplatePath = ".pi/browser-artifacts/fake-nuclei-template.yaml";
	await writeFile(fakeNucleiTemplatePath, "id: fixture-template\ninfo:\n  name: Fixture Template\n  severity: high\n", "utf8");
	await writeFile(fakeNucleiPath, String.raw`import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const valueOf = (name) => { const index = args.indexOf(name); if (index >= 0 && index + 1 < args.length) return args[index + 1]; const pair = args.find((item) => item.startsWith(name + "=")); return pair ? pair.slice(name.length + 1) : undefined; };
const requestFile = valueOf("-rr");
const outputDir = valueOf("-srd") || process.cwd();
const templatePath = valueOf("-t") || "fixture-template.yaml";
const requestText = requestFile ? await readFile(requestFile, "utf8") : "";
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "stored.txt"), requestText, "utf8");
console.log(JSON.stringify({
  "template-id": "fixture-template",
  "template-path": templatePath,
  "info": { "name": "Fixture Exposure", "severity": "high", "tags": ["exposure", "fixture"], "author": ["pi"] },
  "type": "http",
  "host": "http://fixture.local",
  "matched-at": "http://fixture.local/final",
  "matcher-name": "body-word",
  "extractor-name": "dotenv",
  "extracted-results": ["APP_KEY=fixture"],
  "curl-command": "curl -H 'Cookie: session=secret' http://fixture.local/final",
  "request": "GET /final HTTP/1.1\\r\\nCookie: session=secret\\r\\n\\r\\n",
  "response": "HTTP/1.1 200 OK\\r\\nSet-Cookie: session=secret\\r\\n\\r\\nfixture",
  "timestamp": "2026-05-18T00:00:00.000Z"
}));
console.error(requestText.includes("sid=abc") ? "browser cookie observed" : "browser cookie missing");
`, "utf8");
	const nucleiBridge = await runNucleiBridge({ rawRequest: `GET /final HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nCookie: stale=1\r\n\r\n`, defaultScheme: "http", bindBrowserSession: true, cookieMode: "merge", cookieProvider: async () => "sid=abc", nucleiPath: process.execPath, nucleiArgs: [fakeNucleiPath], templatePaths: [fakeNucleiTemplatePath], templateIds: ["fixture-template"], tags: ["exposure"], severities: ["high"], authors: ["pi"], retries: 2, rateLimitPerSecond: 5, concurrency: 2, bulkSize: 2, timeoutMs: 10_000 });
	assert.equal(nucleiBridge.ok, true, "nuclei bridge should complete fixture");
	assert.equal(nucleiBridge.runCount, 1, "nuclei bridge should execute one target by default");
	assert.equal(nucleiBridge.matchCount, 1, "nuclei bridge should parse one match");
	assert.equal(nucleiBridge.matchedRunCount, 1, "nuclei bridge should report matched runs");
	assert.ok(nucleiBridge.matchedTemplateIds.includes("fixture-template"), "nuclei bridge should aggregate matched template ids");
	assert.ok(nucleiBridge.matchedSeverities.includes("high"), "nuclei bridge should aggregate matched severities");
	assert.equal(nucleiBridge.matches[0].templateId, "fixture-template", "nuclei bridge should parse template ids");
	assert.equal(nucleiBridge.matches[0].matcherName, "body-word", "nuclei bridge should parse matcher names");
	assert.equal(nucleiBridge.matches[0].extractorName, "dotenv", "nuclei bridge should parse extractor names");
	assert.equal(nucleiBridge.matches[0].extractedResults[0], "APP_KEY=fixture", "nuclei bridge should parse extracted results");
	const nucleiRequestText = await readFile(nucleiBridge.runs[0].requestFile, "utf8");
	assert.match(nucleiRequestText, /Cookie: stale=1; sid=abc|Cookie: sid=abc; stale=1/, "nuclei bridge should merge browser-session cookies into the request file");
	const nucleiSummary = summarizeNucleiBridgeData(nucleiBridge);
	assert.equal(nucleiSummary.matchCount, 1, "nuclei bridge summary should expose match count");
	assert.equal(JSON.stringify(nucleiSummary).includes("session=secret"), false, "nuclei bridge summary must redact sensitive preview text");

	const templateCheck = await runTemplateCheck({ url: base, templateIds: ["exposure", "openapi"], maxTemplates: 10, maxBodyBytes: 64_000 });
	assert.equal(templateCheck.ok, true, "template check should complete fixture");
	assert.ok(templateCheck.matched.some((item) => item.templateId === "exposure-env" && item.url === `${base}/.env`), "template check should match env exposure");
	assert.ok(templateCheck.matched.some((item) => item.templateId === "git-config" && item.url === `${base}/.git/config`), "template check should match git config exposure");
	assert.ok(templateCheck.matched.some((item) => item.templateId === "openapi" && item.url === `${base}/openapi.json`), "template check should match openapi document");
	const customTemplateCheck = await runTemplateCheck({ url: base, templates: [{ id: "custom-home", path: "/", matchStatus: [200], bodyIncludes: ["Hello"], extractRegex: ["Hello"] }], maxBodyBytes: 64_000 });
	assert.equal(customTemplateCheck.matchedCount, 1, "template check should run inline custom templates");
	const dslTemplateCheck = await runTemplateCheck({ url: base, templates: [{ id: "dsl-json", paths: ["/template-dsl", "/template-dsl"], matcherMode: "all", matchers: [{ type: "status", status: [200] }, { type: "word", part: "header", name: "x-template-fixture", words: ["dsl-ok"] }, { type: "regex", part: "body", regex: ["dsl-token"] }], extractors: [{ type: "regex", name: "token", part: "body", regex: ["\\\"token\\\":\\\"([^\\\"]+)"], group: 1 }, { type: "json", name: "nested", jsonPath: "nested.value" }, { type: "header", name: "fixture", header: "x-template-fixture" }] }], maxBodyBytes: 64_000 });
	assert.equal(dslTemplateCheck.rawResultCount, 2, "template check should record raw duplicate checks");
	assert.equal(dslTemplateCheck.deduplicatedResults, 1, "template check should dedupe duplicate template results");
	assert.equal(dslTemplateCheck.matchedCount, 1, "template DSL matchers should match fixture");
	assert.ok(dslTemplateCheck.matched[0].extracts.some((item) => item.name === "token" && item.value === "dsl-token"), "template DSL regex extractor should expose named value");
	assert.ok(dslTemplateCheck.matched[0].extracts.some((item) => item.name === "nested" && item.value === "json-hit"), "template DSL json extractor should expose schema value");
	assert.match(dslTemplateCheck.matched[0].bodySha256, /^[a-f0-9]{64}$/, "template check should hash response bodies");
	const yamlTemplatePath = ".pi/browser-artifacts/template-dsl-fixture.yaml";
	await writeFile(yamlTemplatePath, `templates:\n  - id: yaml-dsl\n    name: YAML DSL\n    paths:\n      - /template-dsl\n    matchers-condition: all\n    matchers:\n      - type: status\n        status: [200]\n      - type: word\n        part: body\n        words: [dsl-token]\n    extractors:\n      - type: regex\n        name: yaml-token\n        part: body\n        regex: ['\"token\":\"([^\"]+)']\n        group: 1\n`);
	const yamlTemplateCheck = await runTemplateCheck({ url: base, templatePath: yamlTemplatePath, maxBodyBytes: 64_000 });
	assert.equal(yamlTemplateCheck.matchedCount, 1, "template check should load YAML templates");
	assert.ok(yamlTemplateCheck.matched[0].extracts.some((item) => item.name === "yaml-token" && item.value === "dsl-token"), "YAML extractor should preserve output schema");
	const templateSummary = summarizeTemplateCheckData(dslTemplateCheck);
	assert.equal(templateSummary.matchedCount, dslTemplateCheck.matched.length, "template summary should expose matched count");
	assert.equal(templateSummary.deduplicatedResults, 1, "template summary should expose dedup count");

	const callbackStart = await runCallbackOast({ action: "start", sessionId: "contract-callback", correlationId: "corr-contract", maxBodyBytes: 1024, maxEvents: 10, enableHttps: true, enableDns: true, dnsBaseDomain: "oast.local", publicBaseUrl: "https://public.example.test", publicHttpsBaseUrl: "https://secure.example.test", publicDnsBaseDomain: "oast.public", externalMetadata: { provider: "fixture-tunnel", region: "lab" } });
	assert.equal(callbackStart.ok, true, "callback listener should start");
	assert.match(callbackStart.callbackUrl, /^http:\/\//, "callback listener should expose an HTTP callback URL");
	assert.match(callbackStart.httpsCallbackUrl, /^https:\/\//, "callback listener should expose an HTTPS callback URL when enabled");
	assert.equal(callbackStart.dnsCallbackHost, "corr-contract.oast.local", "callback listener should expose a generated DNS callback host when enabled");
	assert.equal(callbackStart.publicDnsCallbackHost, "corr-contract.oast.public", "callback listener should expose a generated public DNS callback host");
	assert.equal(callbackStart.externalMetadata.provider, "fixture-tunnel", "callback listener should persist external metadata");
	assert.match(callbackStart.httpsCertificate.fingerprint256, /:/, "callback listener should expose self-signed certificate metadata for HTTPS listeners");
	const callbackList = await runCallbackOast({ action: "list" });
	assert.ok(callbackList.sessions.some((item) => item.sessionId === "contract-callback" && item.listenerActive === true), "callback list should read persisted active sessions");
	const httpTrigger = await runCallbackOast({ action: "trigger", sessionId: "contract-callback", mode: "http", method: "POST", requestHeaders: { "Content-Type": "application/json", "X-Correlation": "corr-contract" }, body: JSON.stringify({ probe: "corr-contract" }), timeoutMs: 5_000 });
	assert.equal(httpTrigger.count, 1, "callback trigger helper should persist one HTTP callback event");
	assert.equal(httpTrigger.events[0].protocol, "http", "callback HTTP trigger should mark the HTTP protocol");
	const httpsTrigger = await runCallbackOast({ action: "trigger", sessionId: "contract-callback", mode: "https", method: "POST", requestHeaders: { "X-Correlation": "corr-contract" }, body: "secure corr-contract", timeoutMs: 5_000 });
	assert.equal(httpsTrigger.count, 1, "callback trigger helper should persist one HTTPS callback event");
	assert.equal(httpsTrigger.events[0].protocol, "https", "callback HTTPS trigger should mark the HTTPS protocol");
	const dnsTrigger = await runCallbackOast({ action: "trigger", sessionId: "contract-callback", mode: "dns", queryType: "A", timeoutMs: 5_000 });
	assert.equal(dnsTrigger.count, 1, "callback trigger helper should persist one DNS callback event");
	assert.equal(dnsTrigger.events[0].protocol, "dns", "callback DNS trigger should mark the DNS protocol");
	assert.equal(dnsTrigger.events[0].queryName, "corr-contract.oast.local", "callback DNS trigger should query the generated callback host");
	const callbackCollected = await runCallbackOast({ action: "collect", sessionId: "contract-callback" });
	assert.equal(callbackCollected.count, 3, "callback listener should collect the persisted HTTP/HTTPS/DNS events");
	assert.ok(callbackCollected.events.every((event) => event.matchedCorrelation === true), "callback listener should mark correlation hits across all trigger modes");
	const callbackSummary = summarizeCallbackOastData(callbackCollected);
	assert.equal(callbackSummary.eventCount, 3, "callback summary should expose event count");
	assert.ok(callbackSummary.protocolCounts.some((item) => item.key === "http"), "callback summary should expose HTTP protocol counts");
	assert.ok(callbackSummary.protocolCounts.some((item) => item.key === "https"), "callback summary should expose HTTPS protocol counts");
	assert.ok(callbackSummary.protocolCounts.some((item) => item.key === "dns"), "callback summary should expose DNS protocol counts");
	const callbackClear = await runCallbackOast({ action: "clear", sessionId: "contract-callback" });
	assert.equal(callbackClear.cleared, 3, "callback clear should reset persisted events");
	const callbackStatus = await runCallbackOast({ action: "status", sessionId: "contract-callback" });
	assert.equal(callbackStatus.eventCount, 0, "callback status should reflect persisted clears");
	assert.equal(callbackStatus.listenerActive, true, "callback status should retain active worker-backed listeners");
	const callbackStopped = await runCallbackOast({ action: "stop", sessionId: "contract-callback" });
	assert.equal(callbackStopped.listenerActive, false, "callback stop should close persisted listeners");
	assert.equal(callbackStopped.count, 0, "callback stop should return the current persisted event buffer");

	const paramQuery = await runFuzzParams({ url: `${base}/param`, locations: ["query"], paramNames: ["debug"], values: ["0", "1"], matchStatus: [200], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(paramQuery.matchedCount, 1, "query param fuzz should find one matching value");
	assert.equal(paramQuery.matched[0].paramName, "debug");
	assert.equal(paramQuery.matched[0].value, "1");
	assert.equal(paramQuery.matched[0].delta.statusChanged, true, "query fuzz should report baseline delta");

	const jsonRaw = `POST /json HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"role":"user"}`;
	const paramJson = await runFuzzParams({ rawRequest: jsonRaw, defaultScheme: "http", locations: ["json"], paramNames: ["role"], values: ["user", "admin"], matchStatus: [201], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(paramJson.matchedCount, 1, "json param fuzz should find admin value");
	assert.equal(paramJson.matched[0].value, "admin");
	assert.match(paramJson.matched[0].bodySha256, /^[a-f0-9]{64}$/, "param fuzz should hash response bodies");
	assert.ok(paramJson.matched[0].delta.classifier.includes("status"), "param fuzz should classify response delta");

	const nestedJsonRaw = `POST /json HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/json\r\nContent-Length: 38\r\n\r\n{"user":{"role":"user"},"users":[{}]}`;
	const nestedJson = await runFuzzParams({ rawRequest: nestedJsonRaw, defaultScheme: "http", locations: ["json"], paramNames: ["user.role", "users[0].role", "meta"], values: ["admin"], jsonValues: [{ enabled: true }], operations: ["set"], matchStatus: [201], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.ok(nestedJson.matched.some((item) => item.paramName === "user.role" && item.value === "admin"), "json param fuzz should support dotted paths");
	assert.ok(nestedJson.matched.some((item) => item.paramName === "users[0].role" && item.value === "admin"), "json param fuzz should support bracket paths");
	assert.ok(nestedJson.matched.some((item) => item.paramName === "meta" && item.value === "{\"enabled\":true}"), "json param fuzz should support object jsonValues");
	const deleteJson = await runFuzzParams({ rawRequest: nestedJsonRaw, defaultScheme: "http", locations: ["json"], paramNames: ["user.role"], operations: ["delete"], matchStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(deleteJson.matchedCount, 1, "json param fuzz should support delete operation");

	const formRaw = `POST /form HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 9\r\n\r\nrole=user`;
	const paramForm = await runFuzzParams({ rawRequest: formRaw, defaultScheme: "http", locations: ["form"], paramNames: ["role"], values: ["user", "admin"], matchStatus: [202], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(paramForm.matchedCount, 1, "form param fuzz should find admin value");

	const paramHeader = await runFuzzParams({ url: `${base}/header`, locations: ["header"], paramNames: ["X-Debug"], values: ["no", "yes"], matchStatus: [204], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(paramHeader.matchedCount, 1, "header param fuzz should find yes value");
	const multipartBoundary = "----fixture-boundary";
	const multipartRaw = `POST /multipart HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: multipart/form-data; boundary=${multipartBoundary}\r\n\r\n--${multipartBoundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\nuser\r\n--${multipartBoundary}\r\nContent-Disposition: form-data; name="upload"; filename="old.txt"\r\nContent-Type: text/plain\r\n\r\nold\r\n--${multipartBoundary}--\r\n`;
	const multipartField = await runFuzzParams({ rawRequest: multipartRaw, defaultScheme: "http", locations: ["multipart"], paramNames: ["role"], values: ["admin"], matchStatus: [200], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(multipartField.matchedCount, 1, "multipart param fuzz should mutate text fields");
	const multipartFile = await runFuzzParams({ rawRequest: multipartRaw, defaultScheme: "http", locations: ["multipart"], paramNames: ["upload"], jsonValues: [{ filename: "a.txt", contentType: "text/plain", content: "hello" }], matchStatus: [201], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(multipartFile.matchedCount, 1, "multipart param fuzz should mutate file fields");
	const multipartMultiFile = await runFuzzParams({ rawRequest: multipartRaw, defaultScheme: "http", locations: ["multipart"], paramNames: ["upload"], jsonValues: [[{ filename: "a.txt", contentType: "text/plain", content: "alpha" }, { filename: "b.txt", contentType: "text/plain", content: "beta" }]], matchStatus: [206], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(multipartMultiFile.matchedCount, 1, "multipart param fuzz should support multiple files on the same field");
	assert.equal(multipartMultiFile.matched[0].multipart.fileCount, 2, "multipart param fuzz should report repeated file parts");
	assert.equal(multipartMultiFile.matched[0].multipart.repeatedNameCounts[0].name, "upload", "multipart param fuzz should report repeated multipart field names");
	const multipartNested = await runFuzzParams({ rawRequest: multipartRaw, defaultScheme: "http", locations: ["multipart"], paramNames: ["upload"], jsonValues: [{ filename: "nested.bin", contentType: "multipart/form-data", multipart: { fields: [{ name: "innerRole", value: "admin" }], files: [{ name: "innerUpload", filename: "inner.txt", contentType: "text/plain", content: "inside" }] } }], matchStatus: [207], filterStatus: [403], maxBodyBytes: 64_000 });
	assert.equal(multipartNested.matchedCount, 1, "multipart param fuzz should support nested multipart payloads");
	assert.equal(multipartNested.matched[0].multipart.nestedMultipartPartCount, 1, "multipart param fuzz should report nested multipart parts");
	const multipartVariants = await runFuzzParams({ rawRequest: multipartRaw, defaultScheme: "http", locations: ["multipart"], paramNames: ["role"], values: ["admin"], contentTypeVariants: ["quoted", "missing-boundary", "mismatch"], matchStatus: [200,403,415], maxBodyBytes: 64_000 });
	assert.ok(multipartVariants.results.some((item) => item.contentTypeVariant === "quoted" && item.status === 200), "multipart param fuzz should support quoted boundary variants");
	assert.ok(multipartVariants.results.some((item) => item.contentTypeVariant === "missing-boundary" && item.status === 415), "multipart param fuzz should support missing boundary variants");
	assert.ok(multipartVariants.results.some((item) => item.contentTypeVariant === "mismatch" && item.status === 403), "multipart param fuzz should support mismatched boundary variants");
	assert.ok(Array.isArray(multipartVariants.parserClusters) && multipartVariants.parserClusters.length >= 3, "multipart param fuzz should cluster parser-difference responses");
	assert.ok(multipartVariants.parserClusters.some((cluster) => cluster.contentTypeVariants.includes("missing-boundary")), "multipart param fuzz parser clusters should retain content-type variants");
	const paramSummary = summarizeFuzzParamsData(multipartVariants);
	assert.equal(paramSummary.matchedCount, 3, "param fuzz summary should expose matched count");
	assert.ok(Array.isArray(paramSummary.contentTypeVariantCounts) && paramSummary.contentTypeVariantCounts.length >= 3, "param fuzz summary should expose multipart variant counts");
	assert.equal(paramSummary.parserClusterCount, multipartVariants.parserClusters.length, "param fuzz summary should expose parser cluster count");
	assert.ok(paramSummary.parserClusters.count >= 3, "param fuzz summary should expose parser cluster rows");
	assert.equal(JSON.stringify(paramSummary).includes("session=secret"), false, "param fuzz summary must not leak cookie values");

	const raw = `POST /echo HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nContent-Type: text/plain\r\nX-Test: one\r\nCookie: stale=1\r\nContent-Length: 4\r\n\r\nping`;
	const parsed = parseRawHttpRequest(raw, { defaultScheme: "http" });
	assert.equal(parsed.method, "POST");
	assert.equal(parsed.url, `${base}/echo`);
	assert.equal(parsed.headers.Host, `127.0.0.1:${address.port}`);

	const built = buildReplayRequest({ request: { url: `${base}/echo`, method: "POST", headers: [{ name: "X-Captured", value: "yes" }], postData: "captured" }, mutations: { body: "mutated" } });
	assert.equal(built.headers["X-Captured"], "yes");
	assert.equal(built.body, "mutated");

	const replay = await runHttpReplay({
		rawRequest: raw,
		defaultScheme: "http",
		headers: { "X-Test": "two" },
		mutations: { body: "pong" },
		bindBrowserSession: true,
		cookieProvider: async () => "sid=abc; stale=browser",
		maxBodyBytes: 64_000,
	});
	assert.equal(replay.ok, true);
	assert.equal(replay.request.headers.Cookie, "[redacted]", "request Cookie must be redacted in tool result");
	assert.ok(replay.request.omittedHeaderNames.includes("Host"), "Host header must be omitted from Node fetch replay");
	assert.ok(replay.request.omittedHeaderNames.includes("Content-Length"), "Content-Length must be omitted from Node fetch replay");
	const echoed = JSON.parse(replay.response.body.text);
	assert.equal(echoed.method, "POST");
	assert.equal(echoed.headers["x-test"], "two");
	assert.equal(echoed.body, "pong");
	assert.match(echoed.headers.cookie, /sid=abc/);
	assert.match(echoed.headers.cookie, /stale=browser/);
	assert.match(replay.response.body.sha256, /^[a-f0-9]{64}$/, "replay should hash response bodies");
	const compareReplay = await runHttpReplay({ rawRequest: raw, defaultScheme: "http", mutations: { body: "pong" }, compareBaseline: true, maxBodyBytes: 64_000 });
	assert.ok(compareReplay.delta.classifier.includes("body-hash"), "replay should report baseline response deltas");
	const binaryReplay = await runHttpReplay({ url: `${base}/echo`, method: "POST", bodyBase64: Buffer.from([0, 1, 2, 3]).toString("base64"), maxBodyBytes: 64_000 });
	assert.equal(binaryReplay.request.bodyBytes, 4, "replay should send base64 binary bodies");
	assert.equal(JSON.parse(binaryReplay.response.body.text).bodyBase64, Buffer.from([0, 1, 2, 3]).toString("base64"));
	const multipartReplay = await runHttpReplay({ url: `${base}/echo`, method: "POST", multipart: { fields: { role: "admin" }, files: [{ name: "upload", filename: "a.txt", contentType: "text/plain", content: "hello" }] }, maxBodyBytes: 64_000 });
	const multipartEchoed = JSON.parse(multipartReplay.response.body.text);
	assert.match(multipartEchoed.headers["content-type"], /^multipart\/form-data; boundary=/, "replay should construct multipart content type");
	assert.ok(multipartEchoed.body.includes('name="role"'));
	assert.ok(multipartEchoed.body.includes("hello"));
	assert.equal(multipartReplay.request.multipart.fileCount, 1, "replay should report multipart file counts on the request record");
	const multipartMatrixReplay = await runHttpReplay({
		url: `${base}/multipart`,
		method: "POST",
		multipart: {
			fields: { role: "user" },
			files: [{ name: "upload", filename: "a.txt", contentType: "text/plain", content: "hello" }],
			fileFieldMatrix: {
				fieldNames: ["upload", "file"],
				fileValues: [
					{ filename: "a.txt", contentType: "text/plain", content: "hello" },
					[{ filename: "a.txt", contentType: "text/plain", content: "alpha" }, { filename: "b.txt", contentType: "text/plain", content: "beta" }],
					{ filename: "nested.bin", contentType: "multipart/form-data", multipart: { fields: [{ name: "innerRole", value: "admin" }], files: [{ name: "innerUpload", filename: "inner.txt", contentType: "text/plain", content: "inside" }] } },
				],
				maxCases: 10,
			},
		},
		compareBaseline: true,
		maxBodyBytes: 64_000,
	});
	assert.equal(multipartMatrixReplay.mode, "multipart-matrix", "replay should expose multipart matrix mode");
	assert.equal(multipartMatrixReplay.multipartMatrix.caseCount, 6, "replay should generate the bounded multipart matrix cases");
	assert.ok(multipartMatrixReplay.steps.some((step) => step.multipartMatrixCase?.fieldName === "upload" && step.multipartMatrixCase?.kind === "single-file" && step.response?.status === 201), "replay should keep successful single-file upload cases in the matrix");
	assert.ok(multipartMatrixReplay.steps.some((step) => step.multipartMatrixCase?.fieldName === "upload" && step.multipartMatrixCase?.kind === "multi-file" && step.response?.status === 206), "replay should support repeated same-name multipart file parts in the matrix");
	assert.ok(multipartMatrixReplay.steps.some((step) => step.multipartMatrixCase?.fieldName === "upload" && step.multipartMatrixCase?.kind === "nested-multipart" && step.response?.status === 207), "replay should support nested multipart file variants in the matrix");
	assert.ok(multipartMatrixReplay.steps.some((step) => step.multipartMatrixCase?.fieldName === "file" && step.response?.status === 403), "replay should support alternate multipart file field names in the matrix");
	assert.ok(multipartMatrixReplay.steps.some((step) => step.delta?.classifier?.includes("status")), "replay should compare multipart matrix cases against the baseline request when requested");
	const multipartMatrixSummary = summarizeHttpReplayData(multipartMatrixReplay);
	assert.equal(multipartMatrixSummary.multipartMatrix.caseCount, 6, "replay summary should expose multipart matrix case counts");
	assert.ok(multipartMatrixSummary.steps.rows.some((row) => row.includes("upload:multi-file:2")), "replay summary should expose multipart matrix case labels");
	const sequenceReplay = await runHttpReplay({ requests: [{ url: `${base}/set-cookie`, method: "GET" }, { url: `${base}/cookie-check`, method: "GET" }], maxBodyBytes: 64_000 });
	assert.equal(sequenceReplay.mode, "sequence");
	assert.equal(sequenceReplay.stepCount, 2, "replay should execute request sequences");
	assert.equal(sequenceReplay.steps[1].response.status, 200, "sequence replay should carry Set-Cookie values");
	const variableReplay = await runHttpReplay({
		variables: { path: "issue-token" },
		requests: [
			{ url: `${base}/{{path}}`, method: "GET", extractors: [{ type: "json", name: "token", jsonPath: "token" }, { type: "header", name: "flowHeader", header: "x-flow-token" }] },
			{ url: `${base}/use-token?token={{token}}`, method: "POST", headers: { "X-Flow-Token": "{{flowHeader}}" }, body: "token={{token}}" },
		],
		maxBodyBytes: 64_000,
	});
	assert.equal(variableReplay.steps[1].response.status, 200, "replay should inject extracted variables into later steps");
	assert.equal(variableReplay.variables.token, "seq-abc", "replay should retain captured variables in artifact result");
	assert.ok(variableReplay.steps[0].capturedVariableNames.includes("token"), "replay should report captured variable names per step");
	const extractorTypeReplay = await runHttpReplay({
		requests: [
			{ url: `${base}/redirect`, method: "GET", extractors: [{ type: "status", name: "redirectStatus" }, { type: "location", name: "redirectTarget" }] },
			{ url: "{{redirectTarget}}", method: "GET", extractors: [{ type: "title", name: "redirectTitle" }, { type: "body-sha256", name: "redirectBodySha256" }] },
			{ url: `${base}/set-cookie`, method: "GET", extractors: [{ type: "cookie", name: "flow", cookie: "flow" }] },
			{ url: `${base}/cookie-check`, method: "GET", headers: { Cookie: "flow={{flow}}" } },
		],
		maxBodyBytes: 64_000,
	});
	assert.equal(extractorTypeReplay.steps[1].response.status, 200, "replay should support location extractors for later-step injection");
	assert.equal(extractorTypeReplay.steps[3].response.status, 200, "replay should support cookie extractors for later-step injection");
	assert.equal(extractorTypeReplay.variables.redirectStatus, "302", "replay should capture status extractor values");
	assert.equal(extractorTypeReplay.variables.redirectTitle, "Final", "replay should capture title extractor values");
	assert.match(extractorTypeReplay.variables.redirectBodySha256, /^[a-f0-9]{64}$/, "replay should capture body hash extractor values");
	assert.equal(extractorTypeReplay.variables.flow, "ok", "replay should capture cookie extractor values");
	const scopedVariableReplay = await runHttpReplay({
		requests: [
			{ url: `${base}/issue-token`, method: "GET", variableScope: "step", extractors: [{ type: "json", name: "token", jsonPath: "token" }] },
			{ url: `${base}/use-token?token={{token}}`, method: "POST", headers: { "X-Flow-Token": "hdr-123" }, body: "token={{token}}" },
		],
		maxBodyBytes: 64_000,
	});
	assert.equal(scopedVariableReplay.ok, false, "step-scoped replay variables should not be promoted to later steps");
	assert.equal(scopedVariableReplay.steps[1].response.status, 403, "step-scoped replay variables should not resolve in later steps");
	assert.equal(scopedVariableReplay.steps[0].variableScope, "step", "replay should report per-step variable scope");
	assert.equal(scopedVariableReplay.steps[0].persistedVariableNames.length, 0, "step-scoped captures should not be persisted into sequence variables");
	assert.equal(scopedVariableReplay.variableNames.includes("token"), false, "step-scoped captures should not appear in top-level replay variables");
	const clusteredReplay = await runHttpReplay({ requests: [{ url: `${base}/cluster-a`, method: "GET" }, { url: `${base}/cluster-b`, method: "GET" }, { url: `${base}/cluster-c`, method: "GET" }], maxBodyBytes: 64_000 });
	assert.ok(clusteredReplay.clusters.some((cluster) => cluster.count === 2), "replay should cluster identical responses across sequence steps");
	const harDependencyReplay = await runHttpReplay({ har: { log: { entries: [
		{ startedDateTime: "2026-05-18T00:00:00.000Z", request: { method: "GET", url: `${base}/redirect`, headers: [] }, response: { status: 302, headers: [{ name: "Location", value: "/final" }] } },
		{ startedDateTime: "2026-05-18T00:00:01.000Z", request: { method: "GET", url: `${base}/final`, headers: [{ name: "Referer", value: `${base}/redirect` }] }, response: { status: 200, headers: [{ name: "Set-Cookie", value: "flow=ok; Path=/" }] } },
		{ startedDateTime: "2026-05-18T00:00:02.000Z", request: { method: "GET", url: `${base}/cookie-check`, headers: [{ name: "Referer", value: `${base}/final` }, { name: "Cookie", value: "flow=ok" }] }, response: { status: 200, headers: [] } },
	] } }, maxBodyBytes: 64_000 });
	assert.equal(harDependencyReplay.mode, "sequence");
	assert.equal(harDependencyReplay.dependencyGraph.nodeCount, 3, "replay should build HAR dependency graph nodes");
	assert.ok(harDependencyReplay.dependencyGraph.edges.some((edge) => edge.type === "redirect" && edge.fromIndex === 0 && edge.toIndex === 1), "replay should map HAR redirect dependencies");
	assert.ok(harDependencyReplay.dependencyGraph.edges.some((edge) => edge.type === "cookie" && edge.fromIndex === 1 && edge.toIndex === 2), "replay should map HAR cookie dependencies");
	assert.ok(harDependencyReplay.dependencyGraph.edges.some((edge) => edge.type === "referer" && edge.fromIndex === 1 && edge.toIndex === 2), "replay should map HAR referer dependencies");
	const harReplay = await runHttpReplay({ har: { log: { entries: [{ request: { method: "GET", url: `${base}/missing-har`, headers: [] } }, { request: { method: "POST", url: `${base}/echo`, headers: [{ name: "Content-Type", value: "text/plain" }], postData: { text: Buffer.from("har-body").toString("base64"), encoding: "base64" } } }] } }, harUrlPattern: "/echo", maxBodyBytes: 64_000 });
	assert.equal(harReplay.mode, "sequence");
	assert.equal(harReplay.stepCount, 1, "replay should import filtered HAR entries");
	assert.equal(JSON.parse(harReplay.steps[0].response.body.text).body, "har-body");
	const replaySummaryText = JSON.stringify(summarizeHttpReplayData(replay));
	assert.equal(replaySummaryText.includes("sid=abc"), false, "replay summary must not leak bound cookie values");
	assert.equal(replaySummaryText.includes("stale=browser"), false, "replay summary must not leak merged cookie values");
	const sequenceSummary = summarizeHttpReplayData(sequenceReplay);
	assert.equal(sequenceSummary.stepCount, 2, "replay summary should expose sequence count");
	const variableSummary = summarizeHttpReplayData(variableReplay);
	assert.ok(Array.isArray(variableSummary.variableNames) && variableSummary.variableNames.includes("token"), "replay summary should expose variable names without values");
	const scopedSummary = summarizeHttpReplayData(scopedVariableReplay);
	assert.equal(scopedSummary.variableScope, "sequence", "replay summary should expose default variable scope");
	assert.ok(scopedSummary.steps.rows.some((row) => row.includes("step")), "replay summary should expose per-step variable scope");
	const clusterSummary = summarizeHttpReplayData(clusteredReplay);
	assert.ok(clusterSummary.clusters.count >= 2, "replay summary should expose response clusters");
	const harDependencySummary = summarizeHttpReplayData(harDependencyReplay);
	assert.equal(harDependencySummary.dependencyGraph.nodeCount, 3, "replay summary should expose HAR dependency graph node count");
	assert.ok(Array.isArray(harDependencySummary.dependencyGraph.edgeTypes) && harDependencySummary.dependencyGraph.edgeTypes.some((item) => item.key === "cookie"), "replay summary should expose HAR dependency graph edge types");
	const craftedSummaryText = JSON.stringify(summarizeHttpReplayData({ response: { body: { text: '{"cookie":"sid=abc; stale=browser"}' } } }));
	assert.equal(craftedSummaryText.includes("sid=abc"), false, "replay summary must redact cookie values when response bodies echo them");
	assert.ok(craftedSummaryText.includes("[redacted]"), "replay summary must mark redacted sensitive response previews");
} finally {
	await new Promise((resolve) => httpsServer.close(resolve));
	await new Promise((resolve) => server.close(resolve));
}

console.log("web security tools contract ok");
