import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { normalizeCallbackOastOptions } from "../../src/commands/webSecurity/browserNative/callbackOast.ts";

test("callback OAST options preserve listener, trigger, and limit normalization", () => {
	const externalMetadata = { provider: "external", nested: { id: 1 } };
	const normalized = normalizeCallbackOastOptions({
		action: " TRIGGER ",
		sessionId: " session-1 ",
		listenHost: " 0.0.0.0 ",
		dnsListenHost: " ",
		port: "65535",
		httpsPort: 65_536,
		dnsPort: "53",
		publicBaseUrl: " https://public.example/http ",
		publicHttpsBaseUrl: " https://public.example/https ",
		publicDnsBaseDomain: " public.example.test ",
		dnsBaseDomain: " internal.example.test ",
		dnsResponseAddress: " 192.0.2.1 ",
		basePath: " /callback/{{correlationId}} ",
		correlationId: " correlation-1 ",
		responseStatus: 700,
		responseBody: false,
		responseHeaders: { "X-Test": "yes" },
		enableHttps: true,
		enableDns: true,
		externalMetadata,
		mode: "DNS",
		target: " callback.example.test ",
		method: "post",
		requestHeaders: { Accept: "application/json" },
		bodyBase64: Buffer.from("payload").toString("base64"),
		queryName: " query.example.test ",
		queryType: " TXT ",
		resolverHost: " 127.0.0.53 ",
		resolverPort: "5353",
		rejectUnauthorized: true,
		maxEvents: 200_000,
		maxBodyBytes: 20_000_000,
		maxRuntimeMs: 500,
		afterSeq: -1,
		triggerTimeoutMs: 100,
	});

	assert.deepEqual({
		action: normalized.action,
		sessionId: normalized.sessionId,
		listenHost: normalized.listenHost,
		dnsListenHost: normalized.dnsListenHost,
		ports: [normalized.port, normalized.httpsPort, normalized.dnsPort],
		publicUrls: [normalized.publicBaseUrl, normalized.publicHttpsBaseUrl],
		domains: [normalized.publicDnsBaseDomain, normalized.dnsBaseDomain],
		dnsResponseAddress: normalized.dnsResponseAddress,
		basePath: normalized.basePath,
		correlationId: normalized.correlationId,
		responseStatus: normalized.responseStatus,
		responseBody: normalized.responseBody,
		responseHeaders: normalized.responseHeaders,
		mode: normalized.mode,
		target: normalized.target,
		method: normalized.method,
		headers: normalized.headers,
		query: [normalized.queryName, normalized.queryType],
		resolver: [normalized.resolverHost, normalized.resolverPort],
		limits: [normalized.maxEvents, normalized.maxBodyBytes, normalized.maxRuntimeMs, normalized.afterSeq, normalized.timeoutMs],
	}, {
		action: "trigger",
		sessionId: "session-1",
		listenHost: "0.0.0.0",
		dnsListenHost: "0.0.0.0",
		ports: [65_535, 0, 53],
		publicUrls: ["https://public.example/http", "https://public.example/https"],
		domains: ["public.example.test", "internal.example.test"],
		dnsResponseAddress: "192.0.2.1",
		basePath: "/callback/{{correlationId}}",
		correlationId: "correlation-1",
		responseStatus: 599,
		responseBody: "false",
		responseHeaders: { "Content-Type": "text/plain; charset=utf-8", "X-Test": "yes" },
		mode: "dns",
		target: "callback.example.test",
		method: "POST",
		headers: { Accept: "application/json" },
		query: ["query.example.test", "TXT"],
		resolver: ["127.0.0.53", 5353],
		limits: [100_000, 10_000_000, 1_000, 0, 500],
	});
	assert.deepEqual(normalized.body, Buffer.from("payload"));
	assert.equal(normalized.enableHttps, true);
	assert.equal(normalized.enableDns, true);
	assert.equal(normalized.rejectUnauthorized, true);
	assert.notEqual(normalized.externalMetadata, externalMetadata);
	assert.deepEqual(normalized.externalMetadata, externalMetadata);
});

test("callback OAST options preserve trigger aliases and defaults", () => {
	const normalized = normalizeCallbackOastOptions({
		action: false,
		sessionId: "alias-session",
		correlationId: "alias-correlation",
		triggerMode: "https",
		triggerTarget: " https://callback.example.test/ ",
		triggerMethod: "patch",
		headers: { "X-Alias": 1 },
		triggerBody: "alias-body",
		timeoutMs: 900,
	});

	assert.equal(normalized.action, "start");
	assert.equal(normalized.listenHost, "127.0.0.1");
	assert.equal(normalized.dnsListenHost, "127.0.0.1");
	assert.equal(normalized.mode, "https");
	assert.equal(normalized.target, "https://callback.example.test/");
	assert.equal(normalized.method, "PATCH");
	assert.deepEqual(normalized.headers, { "X-Alias": "1" });
	assert.equal(normalized.body, "alias-body");
	assert.equal(normalized.queryType, "A");
	assert.equal(normalized.timeoutMs, 900);
	assert.throws(() => normalizeCallbackOastOptions({ action: "retire" }), /Unsupported browser_callback_oast action: retire/);
});
