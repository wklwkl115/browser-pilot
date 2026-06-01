import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserAbmlRuntime } from "../../../src/abml/verbs/runtime.ts";
import type { BrowserBridgeExecutionResult } from "../../../src/driver/types.ts";
import type { BrowserObservationSnapshotInfo } from "../../../src/driver/types.ts";

type FakeServer = {
	snapshotCalls: Array<Record<string, unknown>>;
	evaluateScripts: string[];
	commandCalls: Array<Record<string, unknown>>;
	snapshot: (options?: { browserSessionId?: string }) => { browserSessionId?: string; defaultTabId?: number; selectionVersion: number; tabs: unknown[] };
	createObservationSnapshot: (snapshot: Omit<BrowserObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }) => BrowserObservationSnapshotInfo;
	sendCommand: (command: Record<string, unknown>, options?: Record<string, unknown>) => Promise<BrowserBridgeExecutionResult>;
};

function fakeServer(): FakeServer {
	const state = {
		snapshotCalls: [] as Array<Record<string, unknown>>,
		evaluateScripts: [] as string[],
		commandCalls: [] as Array<Record<string, unknown>>,
		scrollTop: 0,
		commentValue: "",
		resultValue: "idle",
		observationIndex: 0,
	};
	return {
		snapshotCalls: state.snapshotCalls,
		evaluateScripts: state.evaluateScripts,
		commandCalls: state.commandCalls,
		snapshot(options = {}) {
			state.snapshotCalls.push(options);
			return { browserSessionId: (options.browserSessionId as string | undefined) || "default", defaultTabId: 7, selectionVersion: 3, tabs: [{ tabId: 7, url: "https://example.test/" }] };
		},
		createObservationSnapshot(snapshot) {
			state.observationIndex += 1;
			return { snapshotId: snapshot.snapshotId || `snap-${state.observationIndex}`, ttlMs: 60_000, expired: false, ...snapshot };
		},
		async sendCommand(command, options = {}) {
			state.commandCalls.push({ command, options });
			if (command.cmd === "screenshot.capture") {
				return { id: "shot-1", acknowledged: true, tabId: 7, data: { screenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z8L0AAAAASUVORK5CYII=", format: "png" } };
			}
			if (command.cmd === "frame.list") {
				return { id: "frame-list", acknowledged: true, tabId: 7, data: { frameTree: { frameId: "root" }, frames: [{ frameId: "root", id: "root", url: "https://example.test/checkout", name: "root", securityOrigin: "https://example.test" }, { frameId: "child-x", id: "child-x", url: "https://cross.example.test/app", name: "child", securityOrigin: "https://cross.example.test", parentId: "root" }] } };
			}
			if (command.cmd === "frame.evaluate") {
				if (command.frameId === "child-x") return { id: "frame-eval", acknowledged: true, tabId: 7, data: { ok: false, error_code: "FRAME_EVAL_FAILED", error: "cross-origin frame unreachable" } };
				return { id: "frame-eval", acknowledged: true, tabId: 7, data: { result: { value: { href: "https://example.test/checkout", title: "Checkout" } } } };
			}
			if (command.cmd === "cdp" && command.method === "Runtime.evaluate") {
				const expression = String((command.params as Record<string, unknown>)?.expression || "");
				state.evaluateScripts.push(expression);
				const wrap = (value: Record<string, unknown>) => ({ id: `eval-${state.evaluateScripts.length}`, acknowledged: true, tabId: 7, data: { result: { value } } });
				if (expression.includes("collectActionables") && expression.includes("list_hints")) {
					return wrap({ url: "https://example.test/checkout", title: "Checkout", readyState: "complete", content: "<h1>Checkout</h1>\nStatus: payment required", node_count: 12, truncated: false, actionables: [{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 }, { index: 1, tag: "canvas", role: "img", action: "Canvas board", label: "Canvas board", selector: "#canvas-board", point: { x: 320, y: 180 }, rect: { x: 260, y: 120, width: 120, height: 120 }, hitOk: true, clickable: true, disabled: false, priority: 900 }], list_hints: [{ selector: "main > div.cart > div.item", itemCount: 20, hiddenCount: 17, firstItemPreview: "Item 1 $10" }], canvas_regions: [{ selector: "#canvas-board", point: { x: 320, y: 180 } }] });
				}
				if (expression.includes("__PI_ABML_MUTATION_TICK__") && expression.includes("querySelectorAll(selector)")) {
					const selector = expression.includes("#card") ? "#card" : "#pay";
					const editable = selector === "#card";
					return wrap({ selector, count: 1, unique: true, attached: true, visible: true, disabled: false, editable, inViewport: true, receivesEvents: true, notOccluded: true, focused: editable, scrollable: true, point: { x: editable ? 100 : 180, y: editable ? 200 : 260 }, rect: { x: editable ? 80 : 140, y: editable ? 180 : 240, width: editable ? 220 : 80, height: editable ? 30 : 32 }, url: "https://example.test/checkout", text: editable ? "Card number" : "Pay now", value: state.commentValue, mutationTick: state.resultValue === "clicked" || state.commentValue ? 2 : 1, activeElementMatches: editable, topNode: editable ? "input" : "button" });
				}
				if (expression.includes("activeElementMatches") && expression.includes("mutationTick") && expression.includes("querySelector(\"#pay\")")) {
					return wrap({ url: "https://example.test/checkout", activeElementMatches: false, value: state.resultValue, text: state.resultValue, mutationTick: state.resultValue === "clicked" ? 2 : 1 });
				}
				if (expression.includes("el.click()") && expression.includes("clicked: true")) {
					state.resultValue = "clicked";
					return wrap({ clicked: true });
				}
				if (expression.includes("valueAfterClear") && expression.includes("dispatchEvent(new InputEvent('input'")) {
					if (expression.includes("true")) state.commentValue = "";
					return wrap({ focused: true, editable: true, valueBefore: "", valueAfterClear: state.commentValue });
				}
				if (expression.includes("activeElementMatches") && expression.includes("mutationTick") && expression.includes("querySelector(\"#card\")")) {
					return wrap({ url: "https://example.test/checkout", activeElementMatches: true, value: state.commentValue, text: state.commentValue, mutationTick: state.commentValue ? 3 : 2 });
				}
				if (expression.includes("pickScrollable") && expression.includes("scrollHeight") && expression.includes("atBottom")) {
					return wrap({ selector: "#list", target: "window", scrollTop: state.scrollTop, scrollLeft: 0, scrollHeight: 3000, clientHeight: 800, atTop: state.scrollTop <= 0, atBottom: state.scrollTop >= 2200 });
				}
				if (expression.includes("beforeTop") && expression.includes("afterTop") && expression.includes("scrollBy")) {
					const beforeTop = state.scrollTop;
					state.scrollTop = Math.min(2200, state.scrollTop + 640);
					return wrap({ selector: "#list", target: "window", beforeTop, afterTop: state.scrollTop, changed: state.scrollTop !== beforeTop });
				}
				if (expression.includes("scrollIntoView") && expression.includes("scrolled: true")) {
					return wrap({ scrolled: true });
				}
				throw new Error(`Unexpected Runtime.evaluate script: ${expression.slice(0, 120)}`);
			}
			if (command.cmd === "persistent_cdp" && command.action === "send") {
				if (command.cdpMethod === "Input.insertText") {
					state.commentValue += String((command.params as Record<string, unknown>)?.text || "");
				}
				if (command.cdpMethod === "Accessibility.getFullAXTree") {
					return { id: "ax-tree", acknowledged: true, tabId: 7, data: { result: { nodes: [{ nodeId: "ax-shadow", backendDOMNodeId: 91, role: { value: "button" }, name: { value: "Shadow pay" } }, { nodeId: "ax-far", backendDOMNodeId: 92, role: { value: "button" }, name: { value: "Far away" } }] } } };
				}
				if (command.cdpMethod === "DOM.getBoxModel") {
					const backendNodeId = Number(command.params?.backendNodeId);
					if (backendNodeId === 91) return { id: "box-91", acknowledged: true, tabId: 7, data: { result: { border: [100, 180, 180, 180, 180, 220, 100, 220] } } };
					if (backendNodeId === 92) return { id: "box-92", acknowledged: true, tabId: 7, data: { result: { border: [500, 500, 580, 500, 580, 540, 500, 540] } } };
				}
				return { id: `cdp-${String(command.cdpMethod)}`, acknowledged: true, tabId: 7, data: { ok: true } };
			}
			throw new Error(`Unexpected command: ${JSON.stringify(command)}`);
		},
	};
}

test("abml runtime read uses P3 scan entity model", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000, maxChars: 12_000 });
	const result = await runtime.read?.({ plane: "structure" });
	assert.equal(result?.ok, true);
	assert.equal(result?.entities?.length, 6);
	assert.equal(result?.entities?.[0]?.ref.startsWith("pi-ref://"), true);
	assert.equal((result?.data as Record<string, unknown>)?.snapshotId, "snap-1");
	assert.equal(server.evaluateScripts.some((script) => script.includes("collectActionables") && script.includes("list_hints")), true);
});

test("abml runtime click uses DOM path and verifies state change", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000 });
	const read = await runtime.read?.({ plane: "structure" });
	assert.equal(read?.ok, true);
	const ref = read?.entities?.find((entity) => entity.role === "button")?.ref;
	assert.ok(ref);
	const clicked = await runtime.click?.({ ref });
	assert.equal(clicked?.ok, true);
	assert.equal(clicked?.verification?.status, "verified");
	assert.equal((clicked?.data as Record<string, unknown>)?.transport, "dom");
});

test("abml runtime probe scripts normalize text with a real whitespace regex", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000 });
	const read = await runtime.read?.({ plane: "structure" });
	const ref = read?.entities?.find((entity) => entity.role === "button")?.ref;
	await runtime.click?.({ ref });
	// The page scripts collapse whitespace via /\s+/g. Because they are built as
	// backtick templates, a bare \s once collapsed to the letter "s" (/s+/g),
	// silently breaking text normalization. Lock the emitted regex stays /\s+/g.
	assert(server.evaluateScripts.some((s) => s.includes("replace(/\\s+/g, ' ')")), "a probe script must emit the whitespace regex /\\s+/g");
	assert(!server.evaluateScripts.some((s) => s.includes("replace(/s+/g, ' ')")), "no probe script may emit the collapsed /s+/g");
});

test("abml runtime type focuses target and uses Input.insertText", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000 });
	const typed = await runtime.type?.({ ref: { refId: "pi-ref://control/type", kind: "control", locators: [{ by: "css", value: "#card" }], owner: {}, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true }, observationId: "obs", createdAt: Date.now(), ttlMs: 60_000 }, text: "abc", clear: true });
	assert.equal(typed?.ok, true);
	assert.equal(typed?.verification?.status, "verified");
	assert.equal(server.commandCalls.some((call) => call.command.cdpMethod === "Input.insertText"), true);
});

test("abml runtime scroll performs read-after-scroll collection", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000, maxChars: 12_000 });
	const scrolled = await runtime.scroll?.({ to: "next", steps: 2 });
	assert.equal(scrolled?.ok, true);
	assert.equal(scrolled?.verification?.status, "verified");
	assert.equal((scrolled?.meta as Record<string, unknown>)?.entityCount, 5);
	assert.equal(server.evaluateScripts.filter((script) => script.includes("collectActionables") && script.includes("list_hints")).length >= 2, true);
	assert.equal(Number((scrolled?.data as Record<string, unknown>)?.iterations) >= 2, true);
});

test("abml runtime click supports point-backed vision region refs", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000 });
	const clicked = await runtime.click?.({ ref: { refId: "pi-ref://region/vision-1", kind: "region", locators: [{ by: "point", x: 320, y: 180 }], owner: { tabId: 7 }, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true }, geometry: { point: { x: 320, y: 180 } }, observationId: "obs", createdAt: Date.now(), ttlMs: 60_000 } });
	assert.equal(clicked?.ok, true);
	assert.equal((clicked?.data as Record<string, unknown>)?.transport, "cdp");
	assert.equal((clicked?.data as Record<string, unknown>)?.visualFloor, true);
	assert.equal(clicked?.verification?.status, "verified");
	const inspected = await runtime.read?.({ ref: { refId: "pi-ref://region/vision-1", kind: "region", locators: [{ by: "point", x: 320, y: 180 }], owner: { tabId: 7 }, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true }, geometry: { point: { x: 320, y: 180 } }, observationId: "obs", createdAt: Date.now(), ttlMs: 60_000 } });
	assert.equal(inspected?.ok, true);
	assert.equal((inspected?.data as Record<string, unknown>)?.source, "vision-floor");
});

test("abml runtime pierce returns AX entities for closed-shadow targets", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000 });
	const pierced = await runtime.pierce?.({ ref: { refId: "pi-ref://control/host", kind: "control", locators: [{ by: "css", value: "#host" }], owner: { tabId: 7 }, policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true }, geometry: { point: { x: 140, y: 200 } }, observationId: "obs", createdAt: Date.now(), ttlMs: 60_000 }, depth: 2 });
	assert.equal(pierced?.ok, true);
	assert.equal(pierced?.entities?.length, 1);
	assert.equal(pierced?.entities?.[0]?.name, "Shadow pay");
});

test("abml runtime frame exposes explicit OOPIF reachability boundary", async () => {
	const server = fakeServer();
	const runtime = createBrowserAbmlRuntime(server as any, { timeoutMs: 5_000 });
	const listed = await runtime.frame?.({ depth: 2 });
	assert.equal(listed?.ok, true);
	assert.equal(listed?.entities?.length, 2);
	const childRef = listed?.entities?.find((entity) => entity.hints?.frameId === "child-x")?.ref;
	assert.ok(childRef);
	const blocked = await runtime.frame?.({ ref: childRef });
	assert.equal(blocked?.ok, false);
	assert.equal(blocked?.error.code, "CROSS_ORIGIN_BLOCKED");
});
