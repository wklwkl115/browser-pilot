import { appendFile, readFile, readdir } from "node:fs/promises";
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
	if (tarballs.length !== 1) throw new Error(`release artifact must contain exactly one tarball; found ${tarballs.length}`);
	const tarball = path.resolve(directory, tarballs[0].name);
	const expectedFilename = `${identity.name}-${identity.version}.tgz`;
	if (tarballs[0].name !== expectedFilename) throw new Error(`release filename mismatch: expected ${expectedFilename}, received ${tarballs[0].name}`);
	return { tarball };
}

const identity = await releaseIdentity();
const artifactDirArg = argumentValue("--artifact-dir");
const githubOutput = argumentValue("--github-output");
const artifact = artifactDirArg ? await verifyArtifact(path.resolve(root, artifactDirArg), identity) : undefined;
if (githubOutput && !artifact) throw new Error("--github-output requires --artifact-dir");
if (githubOutput && artifact) {
	await appendFile(githubOutput, `tarball=${artifact.tarball}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ schema: "browser-pilot-release-artifact/v1", ...identity, ...(artifact ?? {}) })}\n`);
