import assert from "node:assert/strict";
import test from "node:test";
import { runObserveProviders } from "../../src/commands/observe/scanProviders.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";

test("observe provider degradation never converts cancellation into unavailable data", async () => {
	const controller = new AbortController();
	const server = {
		getKnownRecorderState(kind: "network" | "hook") {
			return kind === "network" ? { active: true, lastSeq: 0 } : undefined;
		},
		async sendCommand(_command: unknown, options: { signal?: AbortSignal }) {
			assert.equal(options.signal, controller.signal);
			controller.abort();
			throw new Error("transport closed");
		},
	} as unknown as BrowserCommandRuntimePort;
	await assert.rejects(
		() => runObserveProviders({
			server,
			params: {},
			tabId: 7,
			startedAt: Date.now(),
			deadlineAt: Date.now() + 5_000,
			baseline: { entities: [], partialBaseline: false, networkSeq: 0 },
			timings: {},
			signal: controller.signal,
		}),
		(error) => error === controller.signal.reason,
	);
});
