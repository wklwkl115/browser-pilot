#!/usr/bin/env node
import { installBrowserExtension, parseInstallBrowser } from "./install.js";
import { runMcpServer } from "./server.js";

async function main(): Promise<void> {
	if (process.argv[2] !== "install") return await runMcpServer();
	const installed = await installBrowserExtension({ browser: parseInstallBrowser(process.argv.slice(3)) });
	process.stdout.write([
		`Browser Pilot extension ${installed.version} is ready.`,
		`Extension directory: ${installed.installDir}`,
		`Opened ${installed.page} in ${installed.browser}.`,
		'Enable Developer mode, choose "Load unpacked", and select the extension directory above. For upgrades, click Reload.',
	].join("\n") + "\n");
}

main().catch((error) => {
	process.stderr.write(`[browser-pilot-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exitCode = 1;
});
