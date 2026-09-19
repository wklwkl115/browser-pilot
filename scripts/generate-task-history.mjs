import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { taskEvidenceScenario } from "../tests/helpers/taskEvidenceScenario.ts";

const [producer, revision, output] = process.argv.slice(2);
if (!producer || !revision || !output)
	throw new Error(
		"Usage: node --import tsx scripts/generate-task-history.mjs <detached-worktree> <revision> <output-directory>",
	);
const root = path.resolve(producer);
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
if (commit !== git("rev-parse", revision) || git("status", "--porcelain"))
	throw new Error("Producer must be a clean checkout of the requested revision");
const relativeProducer = "src/commands/observe/taskViewProjection.ts";
const { projectTaskObservation } = await import(pathToFileURL(path.join(root, relativeProducer)).href);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const destination = path.resolve(output);
await mkdir(destination, { recursive: true });
const source = await readFile(path.join(root, relativeProducer));
const entries = [];
for (const scenario of ["owned", "mixed-gap"]) {
	const f = taskEvidenceScenario({ wrapped: true });
	// Use only capture fields available to every historical producer.
	f.save.hints = { contextParentRef: f.owner.ref };
	f.save.relations = [];
	if (scenario === "mixed-gap") {
		const saveGroup = {
			...f.owner,
			ref: "bp-ref://region/historical-action-group",
			role: "group",
			name: "Actions",
			hints: { contextParentRef: f.owner.ref },
		};
		f.entities.push(saveGroup);
		f.save.hints = { contextParentRef: saveGroup.ref };
		f.save.relations = [];
		f.entities.splice(f.entities.indexOf(f.description), 1);
	}
	f.observation.snapshot.snapshotId = `history-${scenario}`;
	const canonical = JSON.stringify(f.observation, null, 2);
	const producerArtifacts = path.join(root, ".browser-pilot", "artifacts");
	await mkdir(producerArtifacts, { recursive: true });
	const canonicalPath = path.join(producerArtifacts, `${scenario}.json`);
	await writeFile(canonicalPath, canonical);
	const produced = await projectTaskObservation(f.observation, canonicalPath, canonical, f.spec);
	const descriptor = produced.resources.find((resource) => resource.taskProjection);
	const text = await readFile(descriptor.path, "utf8");
	const artifact = JSON.parse(text);
	const version = artifact.schema.split("/").at(-1);
	const filename = `${version}-${scenario}.json`;
	await copyFile(descriptor.path, path.join(destination, filename));
	entries.push({
		filename,
		schema: artifact.schema,
		policy: artifact.policy,
		producerCommit: commit,
		producerModule: relativeProducer,
		producerModuleSha256: digest(source),
		artifactSha256: digest(text),
		canonicalSha256: digest(canonical),
		nodeVersion: process.version,
		input: f.observation,
		spec: f.spec,
		evidenceStates: artifact.bundles
			.filter((bundle) => bundle.candidate)
			.map((bundle) => ({
				id: bundle.id,
				gaps: bundle.gaps,
				...(bundle.requirements
					? {
							evidence: Object.fromEntries(
								Object.entries(bundle.requirements).map(([kind, report]) => [kind, report.evidence]),
							),
						}
					: {}),
			})),
	});
}
await writeFile(
	path.join(destination, `provenance-${entries[0].schema.split("/").at(-1)}.json`),
	JSON.stringify(entries, null, 2) + "\n",
);
console.log(
	JSON.stringify(
		entries.map(({ filename, producerCommit, artifactSha256 }) => ({ filename, producerCommit, artifactSha256 })),
		null,
		2,
	),
);
