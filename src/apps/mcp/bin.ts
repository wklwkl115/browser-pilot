#!/usr/bin/env node
import { runMcpServer } from "./server.js";

runMcpServer().catch((error) => {
	process.stderr.write(`[browser-pilot-mcp] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
	process.exitCode = 1;
});
