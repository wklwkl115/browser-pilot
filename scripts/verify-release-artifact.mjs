import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argumentValue(name) {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

async function releaseIdentity() {
	const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
	const tag = process.env.GITHUB_REF_NAME;
	const expectedTag = `v${pkg.version}`;
	if (tag !== expectedTag) throw new Error(`release tag mismatch: expected ${expectedTag}, received ${tag || "<missing>"}`);
	return { name: pkg.name, version: pkg.version, tag };
}

async function verifyArtifact(directory, identity) {
	const entries = await readdir(directory, { withFileTypes: true });
	const tarballs = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
	const manifests = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz.sha256.json"));
	if (tarballs.length !== 1 || manifests.length !== 1) {
		throw new Error(`release artifact must contain exactly one tarball and one SHA manifest; found ${tarballs.length}/${manifests.length}`);
	}
	const tarball = path.resolve(directory, tarballs[0].name);
	const manifestPath = path.resolve(directory, manifests[0].name);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const expectedFilename = `${identity.name}-${identity.version}.tgz`;
	if (tarballs[0].name !== expectedFilename || manifest.filename !== expectedFilename) {
		throw new Error(`release filename mismatch: expected ${expectedFilename}, received ${tarballs[0].name}/${manifest.filename}`);
	}
	if (manifests[0].name !== `${expectedFilename}.sha256.json`) throw new Error(`release SHA manifest name mismatch: ${manifests[0].name}`);
	if (manifest.schema !== "browser-pilot-package-smoke/v1" || manifest.name !== identity.name || manifest.version !== identity.version) {
		throw new Error("release manifest identity does not match package.json");
	}
	const bytes = await readFile(tarball);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (manifest.sha256 !== sha256) throw new Error(`release SHA-256 mismatch: expected ${manifest.sha256}, calculated ${sha256}`);
	const info = await stat(tarball);
	if (manifest.compressedSize !== info.size) throw new Error(`release compressed-size mismatch: expected ${manifest.compressedSize}, found ${info.size}`);
	return { tarball, manifestPath, sha256, compressedSize: info.size };
}

const identity = await releaseIdentity();
const artifactDirArg = argumentValue("--artifact-dir");
const githubOutput = argumentValue("--github-output");
const artifact = artifactDirArg ? await verifyArtifact(path.resolve(root, artifactDirArg), identity) : undefined;
if (githubOutput && !artifact) throw new Error("--github-output requires --artifact-dir");
if (githubOutput && artifact) {
	await appendFile(githubOutput, `tarball=${artifact.tarball}\nsha256=${artifact.sha256}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ schema: "browser-pilot-release-artifact/v1", ...identity, ...(artifact ?? {}) })}\n`);
