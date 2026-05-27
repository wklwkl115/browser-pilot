import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserBridgeServer } from "./src/driver/BrowserBridgeServer";
import { resolveBrowserToolCapabilityProfile } from "./src/tools/capabilityProfile";
import { registerBrowserCommands } from "./src/tools/commands";
import { registerBrowserTools } from "./src/tools/registerTools";

export default function piBrowserTools(pi: ExtensionAPI) {
	const server = new BrowserBridgeServer();
	const capabilityProfile = resolveBrowserToolCapabilityProfile();
	server.setCapabilityProfile(capabilityProfile);
	let startPromise: Promise<void> | undefined;

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

	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureStarted();
			ctx.ui.setStatus("browser", `browser:${server.port}`);
		} catch (error) {
			ctx.ui.setStatus("browser", "browser:error");
			ctx.ui.notify(`Browser bridge start failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await server.stop();
		startPromise = undefined;
	});

	registerBrowserCommands(pi, server, ensureStarted);
	registerBrowserTools(pi, server, ensureStarted, { securityToolsEnabled: capabilityProfile.securityToolsEnabled });
}
