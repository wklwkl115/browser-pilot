const mode = process.argv.includes("--version") || process.argv.includes("-version") ? "version" : process.env.BP_STUB_MODE;
if (mode === "version") {
	console.log(process.env.BP_STUB_VERSION || "stub scanner 1.0");
	process.exit(0);
}
if (process.env.BP_STUB_MODE === "echo-argv") {
	console.log(JSON.stringify({ argv: process.argv.slice(2) }));
	process.exit(0);
}
if (process.env.BP_STUB_MODE === "fail-secret") {
	console.log("Authorization: Bearer stdout-secret-token\n" + "x".repeat(1500));
	console.error("Cookie: sid=stderr-secret-token\n" + "y".repeat(1500));
	process.exit(2);
}
if (process.env.BP_STUB_MODE === "nuclei-malformed") {
	console.log('{"template-id":"partial"');
	console.log("not-json");
	console.error("Set-Cookie: sid=malformed-secret-token");
	process.exit(0);
}
if (process.env.BP_STUB_SCANNER === "sqlmap") {
	console.log("back-end DBMS: SQLite\nParameter: q (GET)\n    Type: error-based\n    Title: SQLite error\n    Payload: q='\ncurrent user: 'stub'");
	process.exit(0);
}
if (process.env.BP_STUB_SCANNER === "nuclei") {
	console.log(JSON.stringify({ "template-id": "exposure/test", info: { name: "Exposure", severity: "high", tags: "exposure,debug", authors: ["bp"] }, type: "http", host: "example.test", "matched-at": "https://example.test/debug", "extracted-results": ["secret"], "curl-command": "curl -H 'Cookie: sid=secret' https://example.test/debug", request: "GET /debug HTTP/1.1\nCookie: sid=secret", response: "HTTP/1.1 200 OK\nSet-Cookie: sid=secret" }));
	console.log("{bad-json");
	process.exit(0);
}
process.exit(1);
