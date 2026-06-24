import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import {
	base64UrlEncode,
	parseCommandArgs,
	positiveInt,
} from "../../src/commands/webSecurity/shared/normalize.ts";
import {
	buildMultipartBodyFromParts,
	parseMultipartBody,
	setMultipartContentTypeVariant,
	summarizeMultipartParts,
	type MultipartPart,
} from "../../src/commands/webSecurity/shared/multipart.ts";
import {
	buildHarDependencyGraph,
	harEntriesFromOptions,
	harHeaderValues,
} from "../../src/commands/webSecurity/shared/har.ts";
import {
	analyzeCookieSample,
	tokenFormatOf,
	tokenMutationToken,
	tokenPayloadOf,
	tokenVerifiedOf,
} from "../../src/commands/webSecurity/shared/cookieTokens.ts";
import { parseSqlmapOutput } from "../../src/commands/webSecurity/bridges/sqlmapBridge.ts";

test("normalize helpers bound integers and parse shell-style args without execution", () => {
	assert.equal(positiveInt("12.9", 5), 12);
	assert.equal(positiveInt("0", 5), 5);
	assert.deepEqual(parseCommandArgs("--flag 'two words' \"three four\" escaped\\ value"), ["--flag", "two words", "three four", "escaped value"]);
	assert.throws(() => parseCommandArgs("--unterminated 'quote"), /unclosed/);
});

test("multipart helpers round-trip fields, files, quoted boundaries, and malformed content types", () => {
	const parts: MultipartPart[] = [
		{ name: "field", body: Buffer.from("value") },
		{ name: "upload", filename: "a\"b.txt", contentType: "text/plain", body: Buffer.from("file-body") },
	];
	const built = buildMultipartBodyFromParts(parts, "bp-boundary");
	const headers: Record<string, string> = {};
	setMultipartContentTypeVariant(headers, "bp-boundary", "quoted");
	const parsed = parseMultipartBody(built.body, headers["Content-Type"] ?? "");
	assert.equal(parsed.boundary, "bp-boundary");
	assert.equal(parsed.parts.length, 2);
	assert.equal(parsed.parts[0]?.name, "field");
	assert.equal(parsed.parts[0]?.body.toString(), "value");
	assert.equal(parsed.parts[1]?.filename, "a%22b.txt");
	assert.equal(parsed.parts[1]?.contentType, "text/plain");
	assert.equal(parsed.parts[1]?.body.toString(), "file-body");
	assert.throws(() => parseMultipartBody(built.body, "multipart/form-data"), /missing boundary/);
	assert.deepEqual(summarizeMultipartParts(parsed.parts, parsed.boundary, "quoted"), {
		boundary: "bp-boundary",
		contentTypeVariant: "quoted",
		partCount: 2,
		fieldCount: 1,
		fileCount: 1,
		nestedMultipartPartCount: 0,
		repeatedNameCounts: [],
		filenames: ["a%22b.txt"],
		contentTypes: ["text/plain"],
	});
});

test("HAR helpers select entries and infer redirect, referer, and cookie dependencies", async () => {
	const har = {
		log: {
			entries: [
				{
					request: { method: "GET", url: "https://example.test/login", headers: [] },
					response: { status: 302, redirectURL: "/dashboard", headers: [{ name: "Set-Cookie", value: "sid=abc; Path=/" }] },
				},
				{
					request: { method: "GET", url: "https://example.test/dashboard", headers: [{ name: "Referer", value: "https://example.test/login" }, { name: "Cookie", value: "sid=abc" }] },
					response: { status: 200, headers: [] },
				},
			],
		},
	};
	const selected = await harEntriesFromOptions({ har, harUrlPattern: "dashboard", harMaxEntries: 5 });
	assert.equal(selected.length, 1);
	assert.equal(harHeaderValues([{ name: "set-cookie", value: "sid=abc" }], "Set-Cookie")[0], "sid=abc");
	const graph = buildHarDependencyGraph(har.log.entries.map((input) => ({ input, source: "har" })));
	assert.equal(graph?.nodeCount, 2);
	assert.equal(graph?.edgeCount, 3);
	assert.deepEqual(graph?.edgeTypes.map((item) => item.key).sort(), ["cookie", "redirect", "referer"]);
});

test("cookie token helpers decode, verify, and mutate JWT samples offline", async () => {
	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64UrlEncode(JSON.stringify({ sub: "alice", admin: false }));
	const signature = base64UrlEncode(createHmac("sha256", "secret").update(`${header}.${payload}`).digest());
	const jwt = `${header}.${payload}.${signature}`;
	const result = await analyzeCookieSample({ source: "cookie", name: "session", value: jwt }, ["secret"], { admin: true });
	assert.equal(tokenFormatOf(result), "jwt");
	assert.equal(tokenVerifiedOf(result), true);
	assert.equal(tokenPayloadOf(result)?.sub, "alice");
	assert.match(tokenMutationToken(result) ?? "", /^[^.]+\.[^.]+\.[^.]+$/);
});

test("sqlmap bridge parser extracts findings and redacts no external scanner execution", () => {
	const parsed = parseSqlmapOutput(`
web server operating system: Linux Ubuntu
web application technology: nginx, PHP
back-end DBMS: PostgreSQL
Parameter: id (GET)
    Type: boolean-based blind
    Title: PostgreSQL AND boolean-based blind
    Payload: id=1 AND 1=1

current user: 'app'
current database: 'prod'
current user is DBA: false
banner: PostgreSQL 15
`);
	assert.equal(parsed.vulnerable, true);
	assert.deepEqual(parsed.dbmsFingerprints, ["PostgreSQL"]);
	assert.equal(parsed.webServerOs, "Linux Ubuntu");
	assert.equal(parsed.webTechnology, "nginx, PHP");
	assert.equal(parsed.currentUser, "app");
	assert.equal(parsed.currentDatabase, "prod");
	assert.equal(parsed.isDba, false);
	assert.equal(parsed.banner, "PostgreSQL 15");
	assert.deepEqual(parsed.findings, [{ parameter: "id", place: "GET", type: "boolean-based blind", title: "PostgreSQL AND boolean-based blind", payload: "id=1 AND 1=1" }]);
});
