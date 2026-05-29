import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserBridgeServer } from "./src/driver/BrowserBridgeServer";
import { resolveBrowserToolCapabilityProfile } from "./src/tools/capabilityProfile";
import { registerBrowserCommands } from "./src/tools/commands";
import { registerBrowserTools } from "./src/tools/registerTools";

type SessionUiContext = {
	ui: {
		setStatus(key: string, value?: string): void;
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
};

export default function piBrowserTools(pi: ExtensionAPI) {
	const server = new BrowserBridgeServer();
	const capabilityProfile = resolveBrowserToolCapabilityProfile();
	server.setCapabilityProfile(capabilityProfile);
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
			for (const warning of capabilityProfile.warnings || []) ctx.ui.notify(warning, "warning");
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
	registerBrowserTools(pi, server, ensureStarted, { securityToolsEnabled: capabilityProfile.securityToolsEnabled });
}
