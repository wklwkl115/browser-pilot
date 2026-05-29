import path from "node:path";
import { saveTextArtifact } from "../../artifacts";
import { artifactFallbackName } from "../../toolAdapter";
import { summarizeWasmArtifactData } from "../../summaries/webSecurity/wasm";
import { summarizeWasmWatBridgeData } from "../../summaries/webSecurity/wasmBridge";
import { analyzeWasmArtifact } from "./wasmArtifact";
import { runWasmWatBridge } from "./wasmBridge";

export type WasmShellContext = { cwd?: string } | undefined;

export type WasmShellParams = {
	path: string;
	mode?: "metadata" | "wat";
	outputPath?: string;
	toolPath?: string;
	toolArgs?: string[];
	maxBytes?: number;
	processTimeoutMs?: number;
};

export type WasmShellResult = {
	mode: "metadata" | "wat";
	summary: Record<string, unknown>;
	analysis: Awaited<ReturnType<typeof analyzeWasmArtifact>>;
	bridge?: Awaited<ReturnType<typeof runWasmWatBridge>>["bridge"];
	saved?: { path: string; chars: number; bytes: number; privacy: Record<string, unknown> };
};

export async function runWasmShell(params: WasmShellParams, ctx: WasmShellContext): Promise<WasmShellResult> {
	const mode = params.mode === "wat" ? "wat" : "metadata";
	if (mode === "wat") {
		const result = await runWasmWatBridge({
			path: params.path,
			toolPath: params.toolPath,
			toolArgs: params.toolArgs,
			outputPath: params.outputPath,
			processTimeoutMs: params.processTimeoutMs,
			artifactRoot: path.resolve(ctx?.cwd || process.cwd(), ".pi", "browser-artifacts"),
		});
		return {
			mode,
			summary: { ...summarizeWasmArtifactData(result), bridge: summarizeWasmWatBridgeData(result) },
			analysis: result,
			bridge: result.bridge,
		};
	}
	const analysis = await analyzeWasmArtifact({ path: params.path, maxBytes: params.maxBytes });
	return {
		mode,
		summary: summarizeWasmArtifactData(analysis),
		analysis,
	};
}
