import test from "node:test";
import assert from "node:assert/strict";
import { compactError, errorDiagnosticsFromDetails, errorTaxonomyForCode, normalizeError } from "../../../src/utils/errors.ts";

test("error taxonomy marks INVALID_BROWSER_COMMAND as protocol domain", () => {
	const taxonomy = errorTaxonomyForCode("INVALID_BROWSER_COMMAND", {});
	assert.equal(taxonomy.domain, "protocol");
});

test("error diagnostics extract target/session/pending scopes", () => {
	const diagnostics = errorDiagnosticsFromDetails({ tabId: 7, browserId: "b1", sessionId: "s1", pendingCount: 2, bodyUnavailableReason: "expired" });
	assert.ok(diagnostics.scopes.includes("target"));
	assert.ok(diagnostics.scopes.includes("session"));
	assert.ok(diagnostics.scopes.includes("pending"));
	assert.ok(diagnostics.scopes.includes("network"));
	assert.equal(diagnostics.target?.tabId, 7);
	assert.equal(diagnostics.session?.sessionId, "s1");
	assert.equal(diagnostics.pending?.pendingCount, 2);
});

test("normalizeError handles nested structured errors", () => {
	const normalized = normalizeError({
		error: {
			code: "BODY_UNAVAILABLE",
			message: "body missing",
			details: { requestId: "req-1", postData: "secret=1" },
		},
	});
	assert.equal(normalized.code, "BODY_UNAVAILABLE");
	assert.equal(normalized.taxonomy.domain, "network");
	assert.equal(normalized.details.requestId, "req-1");
	assert.equal(JSON.stringify(compactError({ error: { code: "BODY_UNAVAILABLE", details: { postData: "secret=1" } } })).includes("secret=1"), false);
});

test("normalizeError emits recovery nextActions for artifact path errors", () => {
	const normalized = normalizeError({ code: "ARTIFACT_PATH_REQUIRED", message: "missing path" });
	assert.ok(Array.isArray(normalized.recovery?.nextActions));
	assert.ok(normalized.recovery?.nextActions?.some((item) => item.includes("browser_artifact")));
});

test("normalizeError emits mature bridge recovery actions", () => {
	const launcher = normalizeError({ code: "MATURE_BRIDGE_LAUNCHER_NOT_FOUND", message: "missing launcher", details: { domain: "webSecurity" } });
	assert.equal(launcher.taxonomy.domain, "security");
	assert.ok(launcher.recovery?.nextActions?.some((item) => item.includes("sqlmapPath") || item.includes("nucleiPath")));
	const templates = normalizeError({ code: "MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED", message: "missing templates", details: { domain: "webSecurity" } });
	assert.ok(templates.recovery?.nextActions?.some((item) => item.includes("templatePaths") || item.includes("templateIds")));
});
