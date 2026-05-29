import { textPreview, type Summary } from "../common";
import { isRecord } from "../common";

export function summarizeWasmWatBridgeData(value: unknown): Summary {
	const root = isRecord(value) ? value : {};
	const bridge = isRecord(root.bridge) ? root.bridge : {};
	const artifact = isRecord(bridge.watArtifact) ? bridge.watArtifact : {};
	return {
		tool: bridge.tool,
		launcher: isRecord(bridge.launcher) ? {
			command: bridge.launcher.command,
			source: bridge.launcher.source,
		} : undefined,
		watArtifact: artifact.path ? {
			path: artifact.path,
			bytes: artifact.bytes,
			sha256: artifact.sha256,
			read: artifact.read,
		} : undefined,
		stdoutPreview: typeof bridge.stdoutPreview === "string" ? textPreview(bridge.stdoutPreview, 160) : undefined,
		stderrPreview: typeof bridge.stderrPreview === "string" ? textPreview(bridge.stderrPreview, 160) : undefined,
		nextActions: [
			"read the saved .wat artifact path when bridge output details are needed",
			"if launcher detection fails, install/configure a local wasm2wat-compatible tool and retry with an explicit path",
		],
	};
}
