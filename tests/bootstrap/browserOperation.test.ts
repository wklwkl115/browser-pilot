import assert from "node:assert/strict";
import test from "node:test";
import { withBrowserOperation } from "../../src/commands/browserOperation.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";

test("browser operation keeps target serialization and returns the raw result", async () => {
	const order: string[] = [];
	const server = {
		withTargetTransaction: async (_input, run) => {
			order.push("lock");
			const result = await run();
			order.push("unlock");
			return result;
		},
	} as BrowserCommandRuntimePort;
	const result = await withBrowserOperation({ server, browserSessionId: "session-1", tabId: 7, timeoutMs: 1_000 }, async () => {
		order.push("dispatch");
		return { value: 42 };
	});
	assert.deepEqual(result, { value: 42 });
	assert.deepEqual(order, ["lock", "dispatch", "unlock"]);
});

test("browser operation aborts at its hard timeout", async () => {
	const server = {} as BrowserCommandRuntimePort;
	await assert.rejects(
		withBrowserOperation({ server, timeoutMs: 10 }, ({ signal }) => new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		})),
		/Browser operation exceeded 10ms/,
	);
});
