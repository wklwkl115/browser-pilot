#!/usr/bin/env node
import { installBrowserExtension, parseInstallBrowser } from "./install.js";
import { runMcpServer } from "./server.js";
import { collectStatus, renderStatus } from "./status.js";

const USAGE = [
	"Usage: browser-pilot-mcp [command]",
	"",
	"  (no command)          Run the MCP server on stdio.",
	"  install [--browser chrome|edge]",
	"                        Copy the extension to ~/.browser-pilot/extension and open the extensions page.",
	"  status [--json]       Diagnose the install, daemon, and extension link (alias: doctor).",
	"  help                  Show this message.",
].join("\n");

async function runStatus(args: string[]): Promise<void> {
	const json = args.includes("--json");
	const unknown = args.filter((arg) => arg !== "--json");
	if (unknown.length) throw new Error(`Unknown status option: ${unknown.join(" ")}\n${USAGE}`);
	const report = await collectStatus();
	process.stdout.write((json ? JSON.stringify(report, null, 2) : renderStatus(report)) + "\n");
	if (report.verdict === "fail") process.exitCode = 1;
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case undefined:
			return await runMcpServer();
		case "install": {
			const installed = await installBrowserExtension({ browser: parseInstallBrowser(args) });
			process.stdout.write(
				[
					`Browser Pilot extension ${installed.version} is ready.`,
					`Extension directory: ${installed.installDir}`,
					`Opened ${installed.page} in ${installed.browser}.`,
					'Enable Developer mode, choose "Load unpacked", and select the extension directory above. For upgrades, click Reload.',
					"Run `browser-pilot-mcp status` to confirm the extension connected.",
				].join("\n") + "\n",
			);
			return;
		}
		case "status":
		case "doctor":
			return await runStatus(args);
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(USAGE + "\n");
			return;
		default:
			throw new Error(`Unknown command: ${command}\n${USAGE}`);
	}
}

main().catch((error) => {
	process.stderr.write(
		`[browser-pilot-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
