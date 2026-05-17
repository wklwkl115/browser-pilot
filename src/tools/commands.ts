import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer";
import { stableJson } from "../utils/json";

type EnsureStarted = () => Promise<BrowserBridgeServer>;

function extensionRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function bridgePath(): string {
	return path.join(extensionRoot(), "bridge", "pi_browser_bridge");
}

export function registerBrowserCommands(pi: ExtensionAPI, server: BrowserBridgeServer, ensureStarted: EnsureStarted) {
	pi.registerCommand("browser-status", {
		description: "Show Pi browser bridge status and connected tabs",
		handler: async (_args, ctx) => {
			try { await ensureStarted(); } catch {}
			ctx.ui.notify(stableJson(server.snapshot()), server.snapshot().extensionConnected ? "info" : "warning");
		},
	});

	pi.registerCommand("browser-install", {
		description: "Show Chrome extension path for Pi browser bridge installation",
		handler: async (_args, ctx) => {
			const target = bridgePath();
			ctx.ui.notify(`Load unpacked Chrome extension from: ${target}`, "info");
			ctx.ui.setEditorText(`安装浏览器桥：打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → ${target}`);
		},
	});

	pi.registerCommand("browser-reload", {
		description: "Ask the browser bridge extension to reload itself and diagnose reconnect",
		handler: async (_args, ctx) => {
			try {
				const bridge = await ensureStarted();
				const before = bridge.snapshot();
				const result = await bridge.sendCommand({ cmd: "management", method: "reload" }, { timeoutMs: 5_000 });
				const after = await bridge.waitForExtensionReconnect(before.extension?.id, 10_000);
				ctx.ui.notify(`Browser extension reloaded and reconnected: ${stableJson({ reload: result, reconnect: { extension: after.extension, tabs: after.tabs.length, pending: after.pending.length } })}`, "info");
			} catch (error) {
				ctx.ui.notify(`Browser extension reload/reconnect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
