import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { transform } from "esbuild";

type JsonRecord = Record<string, unknown>;
type HookEvent = { seq: number; type: string; data: unknown };
type HookResponse = { ok: boolean; data?: JsonRecord; error_code?: string };
type HookApi = {
	dispatch(command: string, args?: JsonRecord): HookResponse;
	install(args?: JsonRecord): HookResponse;
	collect(args?: JsonRecord): HookResponse;
	status(args?: JsonRecord): HookResponse;
	uninstall(args?: JsonRecord): HookResponse;
};

const dispatcherSource = await readFile(new URL("../../src/bridge/extension/page_scripts/hook_dispatcher.ts", import.meta.url), "utf8");
const dispatcherScript = new vm.Script((await transform(dispatcherSource, {
	format: "iife",
	loader: "ts",
	sourcefile: "hook_dispatcher.ts",
	target: "es2022",
})).code, { filename: "hook_dispatcher.js" });

function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function pageHarness(overrides: JsonRecord = {}) {
	const listeners = new Map<string, Set<(event: JsonRecord) => void>>();
	const posted: Array<{ message: unknown; targetOrigin: string }> = [];
	const consoleCalls: Array<{ level: string; args: unknown[] }> = [];
	const pageConsole = Object.fromEntries(["log", "warn", "error", "info", "debug"].map((level) => [level, (...args: unknown[]) => {
		consoleCalls.push({ level, args });
	}])) as unknown as Console;
	const windowObject: JsonRecord = {
		location: { origin: "https://page.example" },
		addEventListener(type: string, listener: (event: JsonRecord) => void) {
			const bucket = listeners.get(type) ?? new Set();
			bucket.add(listener);
			listeners.set(type, bucket);
		},
		removeEventListener(type: string, listener: (event: JsonRecord) => void) {
			listeners.get(type)?.delete(listener);
		},
		postMessage(message: unknown, targetOrigin: string) {
			posted.push({ message, targetOrigin });
		},
		...overrides,
	};
	const sandbox = {
		window: windowObject,
		self: windowObject,
		document: {},
		console: pageConsole,
		Request,
		Response,
		URL,
		Blob,
		FormData,
		setTimeout,
		clearTimeout,
	};
	Object.assign(windowObject, { window: windowObject, console: pageConsole });
	dispatcherScript.runInContext(vm.createContext(sandbox));
	const api = windowObject.__BROWSER_PILOT_HOOKS__ as HookApi;
	assert.equal(typeof api?.dispatch, "function");
	return {
		api,
		console: pageConsole,
		consoleCalls,
		posted,
		window: windowObject,
		emit(type: string, event: JsonRecord) {
			for (const listener of listeners.get(type) ?? []) listener(event);
		},
	};
}

function eventsFrom(response: HookResponse): HookEvent[] {
	return (response.data?.events ?? []) as HookEvent[];
}

test("page hook owns install, bounded collection, pause, redaction, and console restoration", () => {
	const page = pageHarness();
	const originalLog = page.console.log;
	const installed = page.api.install({
		session_id: "page-session",
		buffer_size: 4,
		targets: { console: true },
		options: { redact_patterns: ["api-token-[0-9]+"], max_array_items: 2, max_object_keys: 3 },
	});
	assert.equal(installed.ok, true);
	assert.equal(installed.data?.state, "INSTALLED");
	assert.notEqual(page.console.log, originalLog);

	const circular: JsonRecord = { secret: "fixture-secret", token: "api-token-42", values: [1, 2, 3] };
	circular.self = circular;
	page.console.log(circular);
	page.api.dispatch("hook.pause", { session_id: "page-session" });
	page.console.log("paused-secret");
	page.api.dispatch("hook.resume", { session_id: "page-session" });
	page.console.log("fixture-password");

	const collected = page.api.collect({ session_id: "page-session", event_types: ["console."], limit: 20 });
	const consoleEvents = plain(eventsFrom(collected));
	assert.equal(collected.ok, true);
	assert.equal(Number(collected.data?.overflow) > 0, true);
	assert.equal(consoleEvents.some((event) => JSON.stringify(event).includes("paused-secret")), false);
	assert.match(JSON.stringify(consoleEvents), /\[REDACTED\]/);
	assert.doesNotMatch(JSON.stringify(consoleEvents), /fixture-secret|fixture-password|api-token-42/);
	assert.equal(page.consoleCalls.some((entry) => entry.args.includes("paused-secret")), true);

	const removed = page.api.uninstall({ session_id: "page-session" });
	assert.equal(removed.ok, true);
	assert.equal(removed.data?.state, "CLOSED");
	assert.equal(page.console.log, originalLog);
	assert.deepEqual(plain(removed.data?.cleanup_warnings), []);
});

test("page hook records fetch request/response data and restores the original fetch", async () => {
	const originalFetch = async () => new Response("ok", { status: 201 });
	const page = pageHarness({ fetch: originalFetch });
	assert.equal(page.api.install({ session_id: "network-session", targets: { network: true } }).ok, true);
	const wrappedFetch = page.window.fetch as typeof fetch;
	assert.notEqual(wrappedFetch, originalFetch);
	await wrappedFetch("https://page.example/items", { method: "POST", body: "fixture-secret" });

	const events = plain(eventsFrom(page.api.collect({
		session_id: "network-session",
		event_types: ["network."],
		limit: 20,
	})));
	assert.deepEqual(events.map((event) => event.type), ["network.request", "network.response"]);
	assert.equal((events[0]?.data as JsonRecord).url, "https://page.example/items");
	assert.equal(((events[0]?.data as JsonRecord).body as JsonRecord).sample, "[REDACTED]");
	assert.equal((events[1]?.data as JsonRecord).status, 201);

	assert.equal(page.api.uninstall({ session_id: "network-session" }).ok, true);
	assert.equal(page.window.fetch, originalFetch);
});

test("page hook restores exact crypto method identities on uninstall", async () => {
	const getRandomValues = (array: Uint8Array) => {
		array[0] = 7;
		return array;
	};
	const digest = async (_algorithm: unknown, data: Uint8Array) => data.buffer;
	const crypto = { getRandomValues, subtle: { digest } };
	const page = pageHarness({ crypto });
	assert.equal(page.api.install({ session_id: "crypto-session", targets: { crypto: true } }).ok, true);
	assert.notEqual(crypto.getRandomValues, getRandomValues);
	assert.notEqual(crypto.subtle.digest, digest);

	crypto.getRandomValues(new Uint8Array(2));
	await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2]));
	const eventTypes = eventsFrom(page.api.collect({ session_id: "crypto-session", event_types: ["crypto."], limit: 20 })).map((event) => event.type);
	assert.deepEqual(plain(eventTypes), ["crypto.getRandomValues", "crypto.subtle.digest"]);

	assert.equal(page.api.uninstall({ session_id: "crypto-session" }).ok, true);
	assert.equal(crypto.getRandomValues, getRandomValues);
	assert.equal(crypto.subtle.digest, digest);
});

test("page hook keeps internal events off the unowned window-message side channel", async () => {
	const page = pageHarness();
	assert.equal(page.api.install({
		session_id: "batch-session",
		options: { batch_post_message: true, batch_flush_ms: 20 },
	}).ok, true);
	assert.equal(page.api.uninstall({ session_id: "batch-session" }).ok, true);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(page.posted, []);
});
