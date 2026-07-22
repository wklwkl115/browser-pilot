import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPageObservation } from "../../src/commands/observe/scanProjection.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import { isPageObservationV3 } from "../../src/kernels/abml/pageObservation.ts";
import { OBSERVATION_RESOURCES_DETAIL_KEY, type ObservationResourceDescriptor } from "../../src/commands/observe/observationResources.ts";

test("canonical PageObservation returns its first semantic region and opaque MCP resources", async () => {
	const built = buildPageObservation({
		summary: { focus: { gist: { title: "Example" } } },
		entities: [],
		content: "Introduction Install dependencies Verify the build",
		headings: ["Install dependencies", "Verify the build"],
		url: "https://example.test/",
		activeTabId: 7,
		snapshot: { snapshotId: "snapshot-1", sourceMode: "scan", capturedAt: 1, ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: {},
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];

	assert.equal(isPageObservationV3(inline), true);
	assert.equal(isPageObservationV3(artifact), true);
	assert.equal((inline.content as { text?: string }).text, "Introduction");
	assert.equal((inline.content as { complete?: boolean }).complete, false);
	assert.equal((artifact.content as { text?: string }).text, "Introduction Install dependencies Verify the build");
	assert.equal(resources.length, 2);
	assert.ok(resources.every((resource) => resource.uri.startsWith("browser-pilot://observation/") && resource.path === path.resolve(outputPath)));
	assert.equal("saved" in inline, false);
	assert.equal("limits" in inline, false);
	assert.equal("continuation" in inline, false);
});
