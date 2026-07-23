import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerRefDescriptor, resolveRefUriDetailed } from "../../src/resources/resourceRefs.ts";

function tempArtifact(name: string, value: unknown): string {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-resource-test-"));
	const filePath = path.join(cwd, name);
	writeFileSync(filePath, JSON.stringify(value), "utf8");
	return filePath;
}

test("ref store resolves current refs, tracks artifact freshness, and expires stale refs", () => {
	const artifactPath = tempArtifact("ref.json", { value: 1 });
	const now = Date.now();
	const ref = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/current-ref",
			kind: "control",
			locators: [{ by: "css", value: "#submit" }],
			owner: { browserSessionId: "session-2" },
			policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
			observationId: "obs-2",
			createdAt: now,
			ttlMs: 60_000,
		},
		artifactPath,
	});
	const resolved = resolveRefUriDetailed(ref);
	assert.equal(resolved.ok, true);
	assert.equal(resolved.ok ? resolved.ref.fresh : undefined, true);
	writeFileSync(artifactPath, JSON.stringify({ value: "changed" }), "utf8");
	const changed = resolveRefUriDetailed(ref);
	assert.equal(changed.ok ? changed.ref.fresh : undefined, false);
	assert.deepEqual(resolveRefUriDetailed("not-a-ref"), { ok: false, code: "HANDLE_NOT_FOUND", error: "Unrecognized ref URI" });

	const expiredRef = registerRefDescriptor({
		descriptor: {
			refId: "bp-ref://control/expired-ref",
			kind: "control",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			observationId: "obs-expired",
			createdAt: now - 10_000,
			ttlMs: 1,
		},
	});
	assert.deepEqual(resolveRefUriDetailed(expiredRef), { ok: false, code: "REF_STALE", error: "Ref expired" });
});
