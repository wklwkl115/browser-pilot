import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Entity } from "../kernels/abml/entity.js";
import type { EntityDiff, EntityDiffOptions } from "../kernels/abml/diff.js";
import type { TreeDiff, TreeDiffOptions } from "../kernels/abml/treeDiff.js";
import type { JsAstAnalysisOptions, JsAstReductionFact } from "../commands/webSecurity/shared/jsAstTypes.js";

type NativeKernelCommand = "abml.diff" | "abml.treeDiff" | "jsAst.reduce";

type NativeKernelSuccess<T> = {
	ok: true;
	data: T;
};

const NATIVE_KERNELS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

let cachedBinaryPath: string | undefined;

function nativeKernelsDebugEnabled(): boolean {
	return process.env.BROWSER_PILOT_NATIVE_KERNELS_DEBUG === "1";
}

function nativeKernelsDisabled(): boolean {
	return process.env.BROWSER_PILOT_NATIVE_KERNELS === "0" || process.env.BROWSER_PILOT_NATIVE_KERNELS_DISABLE === "1";
}

function debugNativeKernels(message: string, error?: unknown): void {
	if (!nativeKernelsDebugEnabled()) return;
	const suffix = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : "";
	console.warn(`[browser-pilot-native] ${message}${suffix}`);
}

function nativeBinaryName(): string {
	return process.platform === "win32" ? "browser-pilot-native-kernels.exe" : "browser-pilot-native-kernels";
}

function nativeBinaryCandidates(): string[] {
	const envPath = process.env.BROWSER_PILOT_NATIVE_KERNELS_BIN;
	const here = path.dirname(fileURLToPath(import.meta.url));
	const binary = nativeBinaryName();
	return [
		envPath,
		path.resolve(here, "../../native/browser-pilot-kernels/target/release", binary),
		path.resolve(here, "../../../native/browser-pilot-kernels/target/release", binary),
		path.resolve(process.cwd(), "native/browser-pilot-kernels/target/release", binary),
	].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function resolveNativeKernelBinary(): string | null {
	if (cachedBinaryPath) return cachedBinaryPath;
	for (const candidate of nativeBinaryCandidates()) {
		if (existsSync(candidate)) {
			cachedBinaryPath = candidate;
			return candidate;
		}
	}
	return null;
}

function invokeNativeKernel<T>(command: NativeKernelCommand, payload: unknown): T | undefined {
	if (nativeKernelsDisabled()) return undefined;
	const binaryPath = resolveNativeKernelBinary();
	if (!binaryPath) return undefined;
	try {
		const result = spawnSync(binaryPath, [command], {
			input: JSON.stringify(payload),
			encoding: "utf8",
			maxBuffer: NATIVE_KERNELS_MAX_BUFFER_BYTES,
		});
		if (result.error) {
			debugNativeKernels(`failed to spawn ${command}`, result.error);
			return undefined;
		}
		if (result.status !== 0) {
			debugNativeKernels(`${command} exited with ${result.status}`, result.stderr || result.stdout);
			return undefined;
		}
		const parsed = JSON.parse(result.stdout || "null") as NativeKernelSuccess<T> | null;
		return parsed?.ok === true ? parsed.data : undefined;
	} catch (error) {
		debugNativeKernels(`failed to run ${command}`, error);
		return undefined;
	}
}

export function buildNativeEntityDiff(before: Entity[], after: Entity[], options: EntityDiffOptions = {}): EntityDiff | undefined {
	return invokeNativeKernel<EntityDiff>("abml.diff", { before, after, options });
}

export function buildNativeTreeDiff(before: Entity[], after: Entity[], options: TreeDiffOptions = {}): TreeDiff | undefined {
	return invokeNativeKernel<TreeDiff>("abml.treeDiff", { before, after, options });
}

export function applyNativeJsAstReduction(input: {
	sourceText: string;
	candidateNames: string[];
	objectDispatchNames: string[];
	options: Required<JsAstAnalysisOptions>;
}): JsAstReductionFact | undefined {
	return invokeNativeKernel<JsAstReductionFact>("jsAst.reduce", input);
}
