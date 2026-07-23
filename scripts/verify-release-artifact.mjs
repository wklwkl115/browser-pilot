import { appendFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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
	const extensionManifest = JSON.parse(await readFile(path.join(root, "bridge", "browser_pilot_bridge", "manifest.json"), "utf8"));
	if (extensionManifest.version !== pkg.version || extensionManifest.version_name !== `${pkg.version}-browser-pilot`) {
		throw new Error(`extension version mismatch: expected ${pkg.version}, received ${extensionManifest.version || "<missing>"}`);
	}
	const tag = process.env.GITHUB_REF_NAME;
	const expectedTag = `v${pkg.version}`;
	if (tag !== expectedTag) throw new Error(`release tag mismatch: expected ${expectedTag}, received ${tag || "<missing>"}`);
	return { name: pkg.name, version: pkg.version, tag };
}

async function verifyArtifact(directory, identity) {
	const entries = await readdir(directory, { withFileTypes: true });
	const tarballs = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"));
	if (tarballs.length !== 1) throw new Error(`release artifact must contain exactly one tarball; found ${tarballs.length}`);
	const tarball = path.resolve(directory, tarballs[0].name);
	const expectedFilename = `${identity.name}-${identity.version}.tgz`;
	if (tarballs[0].name !== expectedFilename) throw new Error(`release filename mismatch: expected ${expectedFilename}, received ${tarballs[0].name}`);
	const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
	return { tarball, sha256 };
}

const identity = await releaseIdentity();
const artifactDirArg = argumentValue("--artifact-dir");
const githubOutput = argumentValue("--github-output");
const expectedSha256 = argumentValue("--expected-sha256");
const artifact = artifactDirArg ? await verifyArtifact(path.resolve(root, artifactDirArg), identity) : undefined;
if (githubOutput && !artifact) throw new Error("--github-output requires --artifact-dir");
if (expectedSha256 && !artifact) throw new Error("--expected-sha256 requires --artifact-dir");
if (expectedSha256 && artifact?.sha256 !== expectedSha256) throw new Error(`release artifact SHA-256 mismatch: expected ${expectedSha256}, received ${artifact?.sha256}`);
if (githubOutput && artifact) {
	await appendFile(githubOutput, `tarball=${artifact.tarball}\n`, "utf8");
	await appendFile(githubOutput, `sha256=${artifact.sha256}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ schema: "browser-pilot-release-artifact/v1", ...identity, ...(artifact ?? {}) })}\n`);
