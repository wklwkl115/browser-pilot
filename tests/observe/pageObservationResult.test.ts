import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPageObservation } from "../../src/commands/observe/scanProjection.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import { isPageObservationV3 } from "../../src/kernels/abml/pageObservation.ts";

test("canonical PageObservation is persisted once and returned with its artifact path", async () => {
	const built = buildPageObservation({
		summary: { focus: { gist: { title: "Example" } } },
		entities: [],
		content: "Visible content",
		url: "https://example.test/",
		activeTabId: 7,
		snapshot: { snapshotId: "snapshot-1", sourceMode: "scan", capturedAt: 1, ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: {},
		budgetChars: 8_000,
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-"));
	const outputPath = path.join(dir, "observation.json");
	const result = await pageObservationResult({ inline: built.inline, artifact: built.artifact, maxChars: 8_000, outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as unknown;

	assert.equal(isPageObservationV3(inline), true);
	assert.equal(isPageObservationV3(artifact), true);
	assert.equal((inline.saved as { path?: string }).path, path.resolve(outputPath));
});
