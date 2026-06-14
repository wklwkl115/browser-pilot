import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rootRequire = createRequire(path.join(root, "package.json"));
const validationRel = path.join("dist", "utils", "validation.js");

function resolvePackageFile(packageName, rel) {
	try {
		return path.join(path.dirname(rootRequire.resolve(`${packageName}/package.json`)), rel);
	} catch {
		return undefined;
	}
}

function resolveEnvCandidate(value) {
	if (!value) return undefined;
	if (path.isAbsolute(value) || value.startsWith(".") || value.includes("\\") || value.endsWith(".js")) {
		return path.resolve(root, value);
	}
	try {
		return rootRequire.resolve(value);
	} catch {
		return undefined;
	}
}

function npmGlobalRoot() {
	try {
		if (process.platform === "win32") {
			return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		}
		return execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

const globalRoot = npmGlobalRoot();
const validationCandidates = [
	resolveEnvCandidate(process.env.PI_BROWSER_FRAMEWORK_VALIDATION_MODULE),
	resolvePackageFile("@earendil-works/pi-ai", validationRel),
	resolvePackageFile("@earendil-works/pi-coding-agent", path.join("node_modules", "@earendil-works", "pi-ai", validationRel)),
	globalRoot && path.join(globalRoot, "@earendil-works", "pi-ai", validationRel),
	globalRoot && path.join(globalRoot, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", validationRel),
].filter(Boolean);

const validationModulePath = validationCandidates.find((candidate) => existsSync(candidate));
if (!validationModulePath) {
	const message = "Pi framework validation module not found; optional host-validator compatibility fixture skipped";
	if (process.env.PI_BROWSER_REQUIRE_FRAMEWORK_VALIDATION === "1") assert.fail(message);
	console.log(`tool parameter framework validation skipped: ${message}`);
	process.exit(0);
}

const validationModuleUrl = pathToFileURL(validationModulePath).href;
const { validateToolArguments } = await import(validationModuleUrl);

const strictTool = {
	name: "framework-parameter-fixture",
	parameters: Type.Object({
		flag: Type.Optional(Type.Boolean()),
		count: Type.Optional(Type.Number()),
		mode: Type.Optional(Type.Union([Type.Literal("scan"), Type.Literal("html")], { description: "scan | html" })),
	}, { additionalProperties: false }),
};

const converted = validateToolArguments(strictTool, {
	name: strictTool.name,
	arguments: { flag: "true", count: "30", mode: "scan" },
});
assert.equal(converted.flag, true, "framework validation must convert boolean-like strings before execute");
assert.equal(converted.count, 30, "framework validation must convert numeric-like strings before execute");
assert.equal(converted.mode, "scan", "framework validation must preserve valid enum values");

assert.throws(() => validateToolArguments(strictTool, {
	name: strictTool.name,
	arguments: { flag: true, count: 30, mode: "scan", bogusField: 1 },
}), (error) => {
	assert.match(error.message, /must not have additional properties/i, "framework validation must reject unknown top-level fields when additionalProperties:false is set");
	return true;
});

assert.throws(() => validateToolArguments(strictTool, {
	name: strictTool.name,
	arguments: { flag: true, count: 30, mode: "bogus" },
}), (error) => {
	assert.match(error.message, /must match a schema in anyOf|must be equal to constant/i, "framework validation must reject invalid literal-union enum values");
	return true;
});

console.log("tool parameter framework validation ok");
