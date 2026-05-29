import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectMatureBridgeLauncher, assertMatureBridgeProcessResult, type MatureBridgeLauncher } from "./matureBridge";
import { describeTextArtifact } from "./artifacts";
import { analyzeWasmArtifact, type WasmArtifactAnalysis } from "./wasmArtifact";

export type WasmWatBridgeOptions = {
	path: string;
	toolPath?: string;
	toolArgs?: string[];
	outputPath?: string;
	processTimeoutMs?: number;
	artifactRoot?: string;
};

export type WasmWatBridgeResult = WasmArtifactAnalysis & {
	bridge?: {
		launcher: MatureBridgeLauncher;
		tool: "wasm2wat";
		watArtifact: Awaited<ReturnType<typeof describeTextArtifact>>;
		stdoutPreview?: string;
		stderrPreview?: string;
	};
};

function preview(text: string, maxChars = 240): string | undefined {
	const normalized = String(text || "").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

function wasmBridgeCandidates(): MatureBridgeLauncher[] {
	return [
		{ command: "wasm2wat", preArgs: [], source: "auto" },
		{ command: "wasm-tools", preArgs: ["print"], source: "auto" },
	];
}

function detectWasmWatLauncher(options: WasmWatBridgeOptions): MatureBridgeLauncher {
	return detectMatureBridgeLauncher({
		bridgeName: "wasm2wat",
		explicitPath: options.toolPath,
		explicitArgs: options.toolArgs,
		envPathVar: "PI_WASM2WAT_PATH",
		envArgsVar: "PI_WASM2WAT_ARGS",
		envArgs: [],
		autoCandidates: wasmBridgeCandidates(),
		versionArgs: ["--version"],
		successPattern: /(wasm2wat|wasm-tools|binaryen|wabt)/i,
		probeTimeoutMs: options.processTimeoutMs,
	});
}

function bridgeArgs(launcher: MatureBridgeLauncher, inputPath: string): string[] {
	if (launcher.command === "wasm-tools" && launcher.preArgs[0] === "print") return [...launcher.preArgs, inputPath];
	return [...launcher.preArgs, inputPath];
}

export async function runWasmWatBridge(options: WasmWatBridgeOptions): Promise<WasmWatBridgeResult> {
	const analysis = await analyzeWasmArtifact({ path: options.path });
	const launcher = detectWasmWatLauncher(options);
	const args = bridgeArgs(launcher, analysis.input.path);
	const processTimeoutMs = Math.max(1_000, Math.floor(Number(options.processTimeoutMs || 15_000)));
	const result = spawnSync(launcher.command, args, {
		encoding: "utf8",
		timeout: processTimeoutMs,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	assertMatureBridgeProcessResult("wasm2wat", launcher, args, result, processTimeoutMs);
	if ((result.status ?? 1) !== 0) {
		throw new Error(`wasm2wat bridge failed with status ${result.status}`);
	}
	const stdout = String(result.stdout || "");
	const stderr = String(result.stderr || "");
	const targetPath = options.outputPath ? path.resolve(options.outputPath) : path.resolve(analysis.input.path.replace(/\.wasm$/i, "") + ".wat");
	await writeFile(targetPath, stdout, "utf8");
	const watArtifact = await describeTextArtifact(targetPath, {
		artifactRoot: options.artifactRoot,
		kind: "wasm-wat",
		label: "WAT bridge output",
		mediaType: "text/plain; charset=utf-8",
	});
	return {
		...analysis,
		bridge: {
			launcher,
			tool: "wasm2wat",
			watArtifact,
			stdoutPreview: preview(stdout),
			stderrPreview: preview(stderr),
		},
	};
}
