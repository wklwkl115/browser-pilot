import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { installBrowserExtension, parseInstallBrowser } from "../../src/apps/mcp/install.ts";
import { BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER } from "../../src/bridge/security/bridgePairing.ts";

test("extension installer copies the packaged bridge and opens the selected browser page", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-install-"));
	try {
		const sourceDir = path.join(root, "source");
		const installDir = path.join(root, "state", "extension");
		await mkdir(path.join(sourceDir, "dist"), { recursive: true });
		await writeFile(path.join(sourceDir, "manifest.json"), "{}\n");
		await writeFile(
			path.join(sourceDir, "dist", "service-worker.js"),
			`const secret = ${JSON.stringify(BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER)};\n`,
		);
		const installed = await installBrowserExtension({
			sourceDir,
			installDir,
			stateDirectory: path.dirname(installDir),
			browser: parseInstallBrowser(["--browser", "edge"]),
			openPage: async (browser) => ({ browser: browser!, executable: "fixture-edge", page: "edge://extensions" }),
		});
		assert.equal(installed.installDir, installDir);
		assert.equal(installed.page, "edge://extensions");
		const installedWorker = await readFile(path.join(installDir, "dist", "service-worker.js"), "utf8");
		const installedSecret = (await readFile(path.join(root, "state", "bridge-secret"), "utf8")).trim();
		assert.equal(installedWorker.includes(BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER), false);
		assert.equal(installedWorker.includes(installedSecret), true);
		assert.ok(installedSecret.length >= 32);
		assert.throws(() => parseInstallBrowser(["--browser", "firefox"]), /Usage:/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const oldSecret = "existing-pairing-secret-0123456789abcdef";

async function upgradeFixture(t: TestContext) {
	const temporaryRoot = await realpath(os.tmpdir());
	const root = await mkdtemp(path.join(temporaryRoot, "browser-pilot-upgrade-"));
	t.after(async () => {
		if (path.dirname(await realpath(root)) !== temporaryRoot) throw new Error("Unexpected fixture path");
		await rm(root, { recursive: true, force: true });
	});
	const sourceDir = path.join(root, "source");
	const stateDirectory = path.join(root, "state");
	const installDir = path.join(stateDirectory, "extension");
	await mkdir(path.join(sourceDir, "dist"), { recursive: true });
	await mkdir(path.join(installDir, "dist"), { recursive: true });
	await writeFile(path.join(sourceDir, "manifest.json"), '{"version":"next"}');
	await writeFile(
		path.join(sourceDir, "dist", "service-worker.js"),
		`const secret = "${BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER}";`,
	);
	await writeFile(path.join(installDir, "manifest.json"), '{"version":"previous"}');
	await writeFile(path.join(installDir, "dist", "service-worker.js"), `const old = "${oldSecret}";`);
	await writeFile(path.join(stateDirectory, "bridge-secret"), oldSecret);
	const options = {
		sourceDir,
		installDir,
		stateDirectory,
		openPage: async () => ({ browser: "edge" as const, executable: "fixture", page: "edge://extensions" }),
	};
	return {
		root,
		options,
		worker: path.join(installDir, "dist", "service-worker.js"),
		secretFile: path.join(stateDirectory, "bridge-secret"),
	};
}

async function assertPreviousInstall(fixture: Awaited<ReturnType<typeof upgradeFixture>>) {
	assert.equal(await readFile(fixture.worker, "utf8"), `const old = "${oldSecret}";`);
	assert.equal((await readFile(fixture.secretFile, "utf8")).trim(), oldSecret);
	assert.deepEqual((await readdir(fixture.options.stateDirectory)).sort(), ["bridge-secret", "extension"]);
}

test("extension upgrade stages a complete package and preserves the pairing secret", async (t) => {
	const fixture = await upgradeFixture(t);
	await installBrowserExtension(fixture.options);
	assert.equal(await readFile(fixture.worker, "utf8"), `const secret = "${oldSecret}";`);
	assert.equal((await readFile(fixture.secretFile, "utf8")).trim(), oldSecret);
	assert.deepEqual((await readdir(fixture.options.stateDirectory)).sort(), ["bridge-secret", "extension"]);
});

test("extension upgrade rejects missing pairing metadata without replacing the old install", async (t) => {
	const fixture = await upgradeFixture(t);
	await writeFile(path.join(fixture.options.sourceDir, "dist", "service-worker.js"), "// incomplete");
	await assert.rejects(installBrowserExtension(fixture.options), /pairing placeholder/);
	await assertPreviousInstall(fixture);
});

test("extension upgrade rejects an incomplete copy without changing the old install", async (t) => {
	const fixture = await upgradeFixture(t);
	await rm(path.join(fixture.options.sourceDir, "manifest.json"));
	await assert.rejects(installBrowserExtension(fixture.options), /incomplete: missing manifest/);
	await assertPreviousInstall(fixture);
});

test("extension upgrade restores the previous directory if pairing persistence fails", async (t) => {
	const fixture = await upgradeFixture(t);
	// A directory at the secret destination makes the atomic file rename fail on Windows and POSIX.
	await rm(fixture.secretFile);
	await mkdir(fixture.secretFile);
	await assert.rejects(installBrowserExtension(fixture.options), /previous installation was preserved/);
	assert.equal(await readFile(fixture.worker, "utf8"), `const old = "${oldSecret}";`);
	assert.deepEqual((await readdir(fixture.options.stateDirectory)).sort(), ["bridge-secret", "extension"]);
});

test("extension install serializes concurrent updates without touching an active transaction", async (t) => {
	const fixture = await upgradeFixture(t);
	const lockPath = path.join(fixture.options.stateDirectory, "extension-install.lock");
	await writeFile(lockPath, "active-fixture");
	await assert.rejects(installBrowserExtension(fixture.options), /Another extension install is active/);
	assert.equal(await readFile(lockPath, "utf8"), "active-fixture");
	await rm(lockPath);
	await assertPreviousInstall(fixture);
});

test("extension install rejects overlapping source and destination directories", async (t) => {
	const fixture = await upgradeFixture(t);
	await assert.rejects(installBrowserExtension({ ...fixture.options, installDir: fixture.root }), /must not overlap/);
	await assert.rejects(
		installBrowserExtension({ ...fixture.options, installDir: path.join(fixture.options.sourceDir, "nested") }),
		/must not overlap/,
	);
	await assertPreviousInstall(fixture);
});

test("failure to open the browser does not discard an already installed, paired extension", async (t) => {
	const fixture = await upgradeFixture(t);
	await assert.rejects(
		installBrowserExtension({
			...fixture.options,
			openPage: async () => {
				throw new Error("launch fixture failure");
			},
		}),
		/could not be opened/,
	);
	assert.equal(await readFile(fixture.worker, "utf8"), `const secret = "${oldSecret}";`);
	assert.equal((await readFile(fixture.secretFile, "utf8")).trim(), oldSecret);
});
