import assert from "node:assert/strict";
import test from "node:test";
import { validateBridgeCommand } from "../../src/types/nativeProtocol.ts";

let expression = "";
const cdp = {
	async send(_tabId: number, _method: string, params: Record<string, unknown>) {
		expression = String(params.expression || "");
		return { ok: true, data: { result: { result: { value: { ok: true, data: { html: "<html></html>" } } } } } };
	},
};

Object.assign(globalThis, {
	chrome: { runtime: { id: "html-test" } },
	browserPilotPersistentCdpBridge: cdp,
	BrowserPilotPersistentCdp: cdp,
});

const html = await import("../../src/bridge/extension/service_worker/html.ts");

test("html.get applies a bounded default and rejects attempts to exceed it", async () => {
	const result = await html.handleBrowserPilotHtml(7, { cmd: "html.get" });
	assert.equal(result.ok, true);
	assert.match(expression, new RegExp(`const maxBytes = ${html.BROWSER_PILOT_HTML_MAX_BYTES}`));

	const oversized = await html.handleBrowserPilotHtml(7, { cmd: "html.get", maxBytes: html.BROWSER_PILOT_HTML_MAX_BYTES + 1 });
	assert.equal(oversized.ok, false);
	assert.equal(validateBridgeCommand({ cmd: "html.get", tabId: 7, maxBytes: html.BROWSER_PILOT_HTML_MAX_BYTES + 1 }).ok, false);
});
