#!/usr/bin/env node
import { startDaemon } from "./server.js";

const handle = await startDaemon({ onShutdown: () => process.exit(0) });

function shutdown(): void {
	const force = setTimeout(() => process.exit(0), 1_500);
	force.unref();
	void handle.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise<never>(() => {});
