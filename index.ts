import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserBridgeServer } from "./src/driver/BrowserBridgeServer.js";
import { registerBrowserCommands } from "./src/tools/commands.js";
import { registerBrowserTools } from "./src/tools/registerTools.js";

type SessionUiContext = {
	ui: {
		setStatus(key: string, value?: string): void;
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
};

export default function piBrowserTools(pi: ExtensionAPI) {
	const server = new BrowserBridgeServer();
	let startPromise: Promise<void> | undefined;
	let activeSessionCount = 0;

	const ensureStarted = async () => {
		if (!startPromise) {
			startPromise = server.start().catch((error) => {
				startPromise = undefined;
				throw error;
			});
		}
		await startPromise;
		return server;
	};

	pi.on("session_start", async (_event: unknown, ctx: SessionUiContext) => {
		activeSessionCount += 1;
		try {
			await ensureStarted();
			ctx.ui.setStatus("browser", `browser:${server.port}`);
		} catch (error) {
			ctx.ui.setStatus("browser", "browser:error");
			ctx.ui.notify(`Browser bridge start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event: unknown, ctx: SessionUiContext) => {
		activeSessionCount = Math.max(0, activeSessionCount - 1);
		if (activeSessionCount > 0) return;
		await server.stop();
		startPromise = undefined;
		ctx.ui.setStatus("browser", undefined);
	});

	registerBrowserCommands(pi, server, ensureStarted);
	registerBrowserTools(pi, server, ensureStarted);
}
