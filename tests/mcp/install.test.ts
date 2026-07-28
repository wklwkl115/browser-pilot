import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installBrowserExtension, parseInstallBrowser } from "../../src/apps/mcp/install.ts";

test("extension installer copies the packaged bridge and opens the selected browser page", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-install-"));
	try {
		const sourceDir = path.join(root, "source");
		const installDir = path.join(root, "state", "extension");
		await mkdir(path.join(sourceDir, "dist"), { recursive: true });
		await writeFile(path.join(sourceDir, "manifest.json"), "{}\n");
		await writeFile(path.join(sourceDir, "dist", "service-worker.js"), "// built\n");
		const installed = await installBrowserExtension({
			sourceDir,
			installDir,
			browser: parseInstallBrowser(["--browser", "edge"]),
			openPage: async (browser) => ({ browser: browser!, executable: "fixture-edge", page: "edge://extensions" }),
		});
		assert.equal(installed.installDir, installDir);
		assert.equal(installed.page, "edge://extensions");
		assert.equal(await readFile(path.join(installDir, "dist", "service-worker.js"), "utf8"), "// built\n");
		assert.throws(() => parseInstallBrowser(["--browser", "firefox"]), /Usage:/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
