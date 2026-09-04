import { randomBytes } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateStateDirectory, readBridgeSecret, writeBridgeSecret } from "../daemon/daemonControl.js";
import { BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER } from "../../bridge/security/bridgePairing.js";

function inside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}

async function existingEntry(target: string) {
	try {
		return await lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function prepareExtension(source: string, staged: string, secret: string): Promise<void> {
	await cp(source, staged, { recursive: true, force: false, errorOnExist: true });
	for (const relative of ["manifest.json", "dist/service-worker.js"]) {
		try {
			await access(path.join(staged, relative));
		} catch (cause) {
			throw new Error(`Packaged extension is incomplete: missing ${relative}. Run npm run build:bridge.`, {
				cause,
			});
		}
	}
	const workerPath = path.join(staged, "dist", "service-worker.js");
	const worker = await readFile(workerPath, "utf8");
	if (!worker.includes(BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER))
		throw new Error("Packaged extension is missing the browser bridge pairing placeholder. Rebuild the package.");
	await writeFile(workerPath, worker.replaceAll(BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER, secret), "utf8");
}

/** Stage and validate before touching the live install; restore it on an activation/pairing failure. */
export async function installExtensionFiles(
	sourceDir: string,
	requestedInstallDir: string,
	stateDirectory: string,
): Promise<void> {
	const source = await realpath(sourceDir);
	await mkdir(path.dirname(requestedInstallDir), { recursive: true, mode: 0o700 });
	const parent = await realpath(path.dirname(requestedInstallDir));
	const installDir = path.join(parent, path.basename(requestedInstallDir));
	if (inside(source, installDir) || inside(installDir, source))
		throw new Error("Extension source and install directory must not overlap");
	const entry = await existingEntry(installDir);
	if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
		throw new Error("Extension install directory must be a real directory, not a file or symbolic link");
	// A state directory inside the install would move the pairing file and lock during activation.
	if (inside(path.resolve(stateDirectory), installDir))
		throw new Error("Pairing state must be outside the extension directory");
	ensurePrivateStateDirectory(stateDirectory);
	const stateRoot = await realpath(stateDirectory);
	if (inside(stateRoot, installDir)) throw new Error("Pairing state must be outside the extension directory");
	const lockPath = path.join(stateRoot, "extension-install.lock");
	const lock = await open(lockPath, "wx", 0o600).catch((cause: NodeJS.ErrnoException) => {
		if (cause.code === "EEXIST")
			throw new Error(
				`Another extension install is active. If interrupted, inspect ${lockPath} before removing it.`,
				{ cause },
			);
		throw cause;
	});
	let staging: string | undefined;
	let retainBackup = false;
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
		staging = await mkdtemp(path.join(parent, ".browser-pilot-install-"));
		// Protect the copied worker, which will contain the pairing secret, including custom destinations.
		ensurePrivateStateDirectory(staging);
		const staged = path.join(staging, "extension");
		const backup = path.join(staging, "previous");
		// Reuse a valid secret so upgrading one browser does not invalidate another paired browser.
		const secret = readBridgeSecret(stateRoot) ?? randomBytes(32).toString("base64url");
		await prepareExtension(source, staged, secret);
		let backedUp = false;
		let promoted = false;
		try {
			if (await existingEntry(installDir)) {
				await rename(installDir, backup);
				backedUp = true;
			}
			await rename(staged, installDir);
			promoted = true;
			writeBridgeSecret(secret, stateRoot);
		} catch (cause) {
			try {
				if (promoted) await rename(installDir, path.join(staging, "failed"));
				if (backedUp) await rename(backup, installDir);
			} catch (rollbackError) {
				retainBackup = true;
				throw new AggregateError(
					[cause, rollbackError],
					`Extension activation and rollback failed; recovery files retained in ${staging}`,
					{ cause: rollbackError },
				);
			}
			throw new Error("Extension activation failed; the previous installation was preserved", { cause });
		}
	} finally {
		if (staging && !retainBackup) {
			// Only remove the transaction directory we created, never a caller-supplied destination.
			if (path.dirname(staging) !== parent || !path.basename(staging).startsWith(".browser-pilot-install-"))
				console.warn(`[browser-pilot] Refusing to clean unexpected staging path: ${staging}`);
			else
				await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
					console.warn(`[browser-pilot] Install staging cleanup deferred: ${staging}`);
				});
		}
		await lock.close();
		await rm(lockPath, { force: true });
	}
}
