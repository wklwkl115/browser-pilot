import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { inspectVisionRegion } from "../../../src/abml/verbs/visionRuntime.ts";
import { clearResourceStore, resolveResourceUri } from "../../../mcp/resourceStore.ts";

function makeServer() {
	return {
		async sendCommand(command: Record<string, unknown>) {
			if (command.cmd === "screenshot.capture") {
				return { id: "shot-1", acknowledged: true, tabId: 7, data: { screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z8L0AAAAASUVORK5CYII=", format: "png" } };
			}
			if (command.cmd === "cdp" && command.method === "Runtime.evaluate") {
				return { id: "eval-1", acknowledged: true, tabId: 7, data: { result: { value: { url: "https://example.test/canvas", viewport: { width: 800, height: 600 }, text: "Canvas board" } } } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
}

test("abml vision runtime inspects region refs through screenshot floor", async () => {
	clearResourceStore();
	const cwd = path.resolve(process.cwd(), ".pi", "tmp-vision-runtime-test");
	const descriptor = {
		refId: "pi-ref://region/vision-1",
		kind: "region",
		locators: [{ by: "point", x: 320, y: 180 }],
		owner: { tabId: 7, browserSessionId: "default" },
		policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
		semantic: { role: "region", name: "Canvas board" },
		geometry: { point: { x: 320, y: 180 }, box: { x: 260, y: 120, w: 120, h: 120 } },
		observationId: "obs-vision",
		createdAt: Date.now(),
		ttlMs: 60_000,
	};
	try {
		const inspected = await inspectVisionRegion(makeServer() as any, descriptor as any, { cwd, tabId: 7, browserSessionId: "default", timeoutMs: 5_000 });
		assert.equal(inspected.ok, true);
		if (!inspected.ok) return;
		assert.equal(inspected.entity.source, "vision");
		assert.equal(inspected.entity.hints?.visualFloor, true);
		assert.match(inspected.resourceUri, /^browser-result:\/\//);
		assert.ok(resolveResourceUri(inspected.resourceUri));
		assert.equal(inspected.data.point.x, 320);
		assert.equal(typeof inspected.artifactPath, "string");
	} finally {
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
		clearResourceStore();
	}
});
