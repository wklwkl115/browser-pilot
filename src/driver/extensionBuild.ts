import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonOrThrow } from "../utils/json.js";
import { isRecord } from "../utils/records.js";

export type ExpectedExtensionBuild = {
	buildId?: string;
	manifestPath?: string;
};

export type ExtensionBuildComparison = {
	extensionStale?: boolean;
	expectedBuild?: string;
	reportedBuild?: string;
	manifestPath?: string;
};

function packageRoot(): string {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	if (existsSync(path.join(root, "package.json"))) return root;
	const parent = path.dirname(root);
	return existsSync(path.join(parent, "package.json")) ? parent : root;
}

function expectedExtensionBuildManifestPath(): string {
	return process.env.PI_BROWSER_EXPECTED_EXTENSION_BUILD_MANIFEST
		|| path.join(packageRoot(), "bridge", "pi_browser_bridge", "dist", "build-manifest.json");
}

export function readExpectedExtensionBuild(): ExpectedExtensionBuild {
	const manifestPath = expectedExtensionBuildManifestPath();
	try {
		const parsed = parseJsonOrThrow<Record<string, unknown>>(readFileSync(manifestPath, "utf8"), "extension build manifest");
		return {
			buildId: typeof parsed.buildId === "string" ? parsed.buildId : undefined,
			manifestPath,
		};
	} catch {
		return { manifestPath };
	}
}

function buildIdFromExtensionPayload(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const build = payload.build;
	if (isRecord(build) && typeof build.buildId === "string") {
		return build.buildId;
	}
	return undefined;
}

export function compareExtensionBuild(payload: unknown, expected: ExpectedExtensionBuild): ExtensionBuildComparison {
	if (!expected.buildId) return { manifestPath: expected.manifestPath };
	const reported = buildIdFromExtensionPayload(payload);
	return {
		extensionStale: reported !== expected.buildId,
		expectedBuild: expected.buildId,
		reportedBuild: reported,
		manifestPath: expected.manifestPath,
	};
}
