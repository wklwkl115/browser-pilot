import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reference = process.argv.includes("--ref") ? process.argv[process.argv.indexOf("--ref") + 1] : "1573380";
const write = process.argv.includes("--write");
const target = path.join(root, "tests", "fixtures", "observe-v2-baseline-1573380.json");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

const commit = run("git", ["rev-parse", `${reference}^{commit}`]);
const temp = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-baseline-"));
try {
	const archive = path.join(temp, "source.tar");
	run("git", ["archive", "--format=tar", "--output", archive, commit]);
	run("tar", ["-xf", archive, "-C", temp]);
	await symlink(path.join(root, "node_modules"), path.join(temp, "node_modules"), process.platform === "win32" ? "junction" : "dir");

	const testPath = path.join(temp, "tests", "observe", "observeRegressionBenchmark.test.ts");
	const original = await readFile(testPath, "utf8");
	const instrumented = original.replace(/test\("observe regression benchmark cases are offline and deterministic"[\s\S]*$/u, "export { cases, buildCollections, buildObservation };\n");
	if (instrumented === original) throw new Error("reference benchmark source did not contain the expected terminal test owner");
	await writeFile(testPath, instrumented, "utf8");

	const runnerPath = path.join(temp, "observe-baseline-runner.mts");
	await writeFile(runnerPath, `
import { cases, buildCollections, buildObservation } from "./tests/observe/observeRegressionBenchmark.test.ts";
const fixtures = Object.fromEntries(cases.flatMap((caseDef) => {
  const observation = buildObservation(caseDef, buildCollections(caseDef));
  if (!observation) return [];
  const rendered = JSON.stringify(observation);
  const bytes = Buffer.byteLength(rendered, "utf8");
  return [[caseDef.name, {
    chars: rendered.length,
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    qualityAssertions: Object.keys(caseDef.expect).sort(),
  }]];
}));
process.stdout.write(JSON.stringify(fixtures));
`, "utf8");
	const fixturesText = run(process.execPath, ["--import", "tsx", runnerPath], { cwd: temp });
	const fixtures = JSON.parse(fixturesText);
	const names = Object.keys(fixtures).sort();
	if (names.length < 5) throw new Error(`reference benchmark produced only ${names.length} observation fixtures`);
	const baseline = {
		schema: "browser-pilot-observation-benchmark-baseline/v1",
		source: { ref: reference, commit, commandContractVersion: 2, observationContract: "v2" },
		costModel: { chars: "JSON UTF-16 code units", bytes: "UTF-8", estimatedTokens: "ceil(bytes/4)" },
		fixtureSetHash: sha256(JSON.stringify(names.map((name) => [name, fixtures[name].qualityAssertions]))),
		fixtures: Object.fromEntries(names.map((name) => [name, fixtures[name]])),
	};
	const rendered = `${JSON.stringify(baseline, null, 2)}\n`;
	if (!write) {
		process.stdout.write(rendered);
		process.stderr.write(`preview only; pass --write to update ${path.relative(root, target)}\n`);
	} else {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, rendered, "utf8");
		process.stdout.write(`updated ${path.relative(root, target)} from ${commit}\n`);
	}
} finally {
	await rm(temp, { recursive: true, force: true });
}
