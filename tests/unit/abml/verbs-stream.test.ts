import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserAbmlRuntime } from "../../../src/abml/verbs/runtime.ts";
import type { BrowserBridgeExecutionResult } from "../../../src/driver/types.ts";
import type { BrowserObservationSnapshotInfo } from "../../../src/driver/types.ts";

// R3.x P2-C — causal stream plane (cursor-based drain channel). Exercises the runtime against a fake
// bridge plus the REAL pi-ref store (capture-refs are minted/resolved in-process), proving: arm pins the
// cursor at the recorder high-water, drain returns redacted stream entities + advances the cursor, the
// refreshed captureRef round-trips, recorder-inactive degrades to `unavailable`, and the filter.sinceSeq
// escape hatch drains without a prior ref.

type StreamState = {
	netActive: boolean;
	netItems: Array<Record<string, unknown>>;
	netLastSeq: number | undefined;
	hookItems: Array<Record<string, unknown>>;
	hookLastSeq: number | undefined;
	calls: Array<Record<string, unknown>>;
};

function streamServer(initial: Partial<StreamState> = {}) {
	const state: StreamState = {
		netActive: true,
		netItems: [],
		netLastSeq: undefined,
		hookItems: [],
		hookLastSeq: undefined,
		calls: [],
		...initial,
	};
	const ack = (data: Record<string, unknown>): BrowserBridgeExecutionResult => ({ id: `cmd-${state.calls.length}`, acknowledged: true, tabId: 7, data } as unknown as BrowserBridgeExecutionResult);
	const server = {
		snapshot(options: { browserSessionId?: string } = {}) {
			return { browserSessionId: options.browserSessionId || "default", defaultTabId: 7, selectionVersion: 1, tabs: [{ tabId: 7, url: "https://shop.test/" }] };
		},
		createObservationSnapshot(snapshot: Omit<BrowserObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }): BrowserObservationSnapshotInfo {
			return { snapshotId: snapshot.snapshotId || "snap-1", ttlMs: 60_000, expired: false, ...snapshot } as BrowserObservationSnapshotInfo;
		},
		async sendCommand(command: Record<string, unknown>, _options?: Record<string, unknown>): Promise<BrowserBridgeExecutionResult> {
			state.calls.push(command);
			switch (command.cmd) {
				case "network.status":
					return ack(state.netActive ? { active: true, ...(state.netLastSeq !== undefined ? { lastSeq: state.netLastSeq } : {}) } : { active: false });
				case "network.list": {
					const since = Number(command.sinceSeq ?? 0);
					return ack({ items: state.netItems.filter((r) => Number(r.seq) > since) });
				}
				case "hook.status":
					return ack(state.hookLastSeq !== undefined ? { last_seq: state.hookLastSeq } : {});
				case "hook.collect": {
					const since = Number(command.since_seq ?? 0);
					return ack({ events: state.hookItems.filter((e) => Number(e.seq) > since) });
				}
				default:
					return ack({});
			}
		},
	};
	return { server, state };
}

const refOf = (result: unknown): string => {
	const data = (result as { data?: Record<string, unknown> }).data || {};
	return String(data.captureRef);
};

test("P2-C network: arm pins cursor at the recorder high-water and returns a signal capture-ref", async () => {
	const { server, state } = streamServer({ netLastSeq: 12 });
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const arm = await runtime.read!({ plane: "network" });
	assert.equal(arm.ok, true);
	assert.ok(arm.ok && arm.data);
	if (!arm.ok) return;
	assert.equal(arm.data!.armed, true, "no ref → arm");
	assert.equal(arm.data!.cursor, 12, "cursor pinned at current high-water (no history replay)");
	assert.equal((arm.entities || []).length, 0, "arm yields no delta");
	assert.match(refOf(arm), /^pi-ref:\/\/signal\//, "arm mints a signal capture-ref cursor");
});

test("P2-C network: drain returns redacted entities, advances the cursor, refreshes the ref", async () => {
	const { server, state } = streamServer({ netLastSeq: 12 });
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const arm = await runtime.read!({ plane: "network" });
	assert.ok(arm.ok);
	// Two requests fire after the arm (one carrying a secret in the query string).
	state.netItems = [
		{ seq: 13, requestId: "r13", request: { url: "https://shop.test/api/cart?token=SECRET123", method: "POST" }, response: { status: 200 }, type: "Fetch", updatedAt: 100 },
		{ seq: 14, requestId: "r14", request: { url: "https://shop.test/api/ping", method: "GET" }, response: { status: 204 }, type: "XHR", updatedAt: 200 },
	];
	state.netLastSeq = 14;
	const drain = await runtime.read!({ plane: "network", ref: refOf(arm) });
	assert.ok(drain.ok && drain.data);
	if (!drain.ok) return;
	assert.equal(drain.data!.armed, false, "ref present → drain");
	assert.equal(drain.data!.sinceSeq, 12, "drained since the armed cursor");
	assert.equal(drain.data!.cursor, 14, "cursor advanced to the last consumed seq");
	const entities = drain.entities || [];
	assert.equal(entities.length, 2, "both delta requests became stream entities");
	assert.deepEqual(entities.map((e) => e.ref), ["pi-ref://network/r13", "pi-ref://network/r14"], "entity refs use the causal scheme (match data.causal)");
	const serialized = JSON.stringify(entities);
	assert.ok(!serialized.includes("SECRET123"), "raw secret never leaves redaction (entity url/name redacted)");
	assert.match(refOf(drain), /^pi-ref:\/\/signal\//);
	assert.notEqual(refOf(drain), refOf(arm), "drain hands back a refreshed cursor ref");
	const causal = drain.data!.causal as { requests?: unknown[] };
	assert.equal((causal.requests || []).length, 2, "compact redacted causal mirrors the entities");
});

test("P2-C network: a second drain with nothing new yields no entities and holds the cursor", async () => {
	const { server, state } = streamServer({ netLastSeq: 5 });
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const arm = await runtime.read!({ plane: "network" });
	state.netItems = [{ seq: 6, requestId: "r6", request: { url: "https://shop.test/a", method: "GET" }, response: { status: 200 }, type: "XHR" }];
	state.netLastSeq = 6;
	const first = await runtime.read!({ plane: "network", ref: refOf(arm) });
	assert.ok(first.ok && (first.entities || []).length === 1);
	const second = await runtime.read!({ plane: "network", ref: refOf(first) });
	assert.ok(second.ok && second.data);
	if (!second.ok) return;
	assert.equal((second.entities || []).length, 0, "no new requests → empty delta");
	assert.equal(second.data!.cursor, 6, "cursor held at the last consumed seq");
});

test("P2-C network: filter.sinceSeq drains explicitly without a prior capture-ref", async () => {
	const { server, state } = streamServer({ netLastSeq: 9 });
	state.netItems = [
		{ seq: 1, requestId: "r1", request: { url: "https://shop.test/x", method: "GET" }, response: { status: 200 }, type: "XHR" },
		{ seq: 2, requestId: "r2", request: { url: "https://shop.test/y", method: "GET" }, response: { status: 200 }, type: "XHR" },
	];
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const drain = await runtime.read!({ plane: "network", filter: { sinceSeq: 0 } });
	assert.ok(drain.ok && drain.data);
	if (!drain.ok) return;
	assert.equal(drain.data!.armed, false, "explicit sinceSeq is a drain, not an arm");
	assert.equal((drain.entities || []).length, 2, "drained from seq 0 → both records");
	assert.equal(drain.data!.cursor, 2);
});

test("P2-C network: recorder inactive degrades to unavailable (no throw, opt-in posture)", async () => {
	const { server } = streamServer({ netActive: false });
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const res = await runtime.read!({ plane: "network" });
	assert.ok(res.ok && res.data);
	if (!res.ok) return;
	assert.equal((res.entities || []).length, 0);
	assert.match(String(res.data!.unavailable), /network recorder not active/);
	assert.equal(res.data!.recorderActive, false);
});

test("P2-C event: arm + drain over the hook plane, redacted summary, event refs", async () => {
	const { server, state } = streamServer({ hookLastSeq: 3 });
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const arm = await runtime.read!({ plane: "event" });
	assert.ok(arm.ok && arm.data);
	if (!arm.ok) return;
	assert.equal(arm.data!.cursor, 3, "hook high-water from hook.status.last_seq");
	state.hookItems = [
		{ seq: 4, type: "console.error", timestamp: 100, data: { args: ["boom password=hunter2"] } },
		{ seq: 5, type: "domSink", timestamp: 200, data: {}, elementRef: { selector: "#pay" } },
	];
	state.hookLastSeq = 5;
	const drain = await runtime.read!({ plane: "event", ref: refOf(arm) });
	assert.ok(drain.ok && drain.data);
	if (!drain.ok) return;
	const entities = drain.entities || [];
	assert.equal(entities.length, 2, "both hook events became event entities");
	assert.deepEqual(entities.map((e) => e.ref), ["pi-ref://event/4", "pi-ref://event/5"], "event entity refs use the causal scheme");
	assert.equal(drain.data!.cursor, 5, "cursor advanced over the hook delta");
	assert.ok(!JSON.stringify(entities).includes("hunter2"), "raw secret in a console arg stays redacted in the event summary");
	const causal = drain.data!.causal as { events?: unknown[] };
	assert.equal((causal.events || []).length, 2);
});

test("P2-C event: hook session not armed degrades to unavailable", async () => {
	const { server } = streamServer({ hookLastSeq: undefined });
	const runtime = createBrowserAbmlRuntime(server, { tabId: 7, timeoutMs: 2000 });
	const res = await runtime.read!({ plane: "event" });
	assert.ok(res.ok && res.data);
	if (!res.ok) return;
	assert.match(String(res.data!.unavailable), /hook session not armed/);
});
