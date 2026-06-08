import test from "node:test";
import assert from "node:assert/strict";
import { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";

type LeaseCleanupLogger = {
	logLeaseCleanup(details: { reason: "disconnect"; releasedLeases: unknown[]; releasedUiLocks: unknown[]; disconnectedTabSessionIds: string[]; affectedBrowserSessionIds: string[] }): void;
};

test("BrowserBridgeServer keeps expected disconnect lease cleanup quiet unless explicitly enabled", () => {
	const previous = process.env.PI_BROWSER_LEASE_CLEANUP_LOG;
	const originalWarn = console.warn;
	const warnings: unknown[][] = [];
	console.warn = (...args: unknown[]) => { warnings.push(args); };
	try {
		const server = new BrowserBridgeServer() as unknown as LeaseCleanupLogger;
		const details = {
			reason: "disconnect" as const,
			releasedLeases: [{ id: "lease-a" }],
			releasedUiLocks: [],
			disconnectedTabSessionIds: ["browser-a:1"],
			affectedBrowserSessionIds: ["default"],
		};
		delete process.env.PI_BROWSER_LEASE_CLEANUP_LOG;
		server.logLeaseCleanup(details);
		assert.equal(warnings.length, 0, "normal browser disconnect cleanup must not pollute stderr on successful smoke runs");
		process.env.PI_BROWSER_LEASE_CLEANUP_LOG = "1";
		server.logLeaseCleanup(details);
		assert.equal(warnings.length, 1, "lease cleanup diagnostics remain available through the explicit debug env gate");
		assert.match(String(warnings[0][0]), /Released lease\/UI lock state after client disconnect/);
	} finally {
		console.warn = originalWarn;
		if (previous === undefined) delete process.env.PI_BROWSER_LEASE_CLEANUP_LOG;
		else process.env.PI_BROWSER_LEASE_CLEANUP_LOG = previous;
	}
});
