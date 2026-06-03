/**
 * Live-browser CLI smoke — the gate for the irreversible MCP removal (CLI migration P3/P4).
 *
 * Proves the full CLI execution path end-to-end against a REAL browser:
 *   start daemon → control /invoke → BrowserBridgeServer → extension → page eval → back.
 * Run this with a browser connected (extension loaded + a tab open) BEFORE deleting
 * the MCP shell / dropping @modelcontextprotocol/sdk.
 *
 *   npm run smoke:cli
 *
 * Exit codes: 0 PASS · 3 NEEDS BROWSER (no extension connected — re-run with one) · 1 FAIL.
 */
import { startDaemon } from "../../cli/daemon.ts";
import { controlRequest } from "../../cli/daemonControl.ts";

const results = [];
function record(step, ok, data = {}) {
	results.push({ step, ok, ...data });
	console.log(`${ok ? "✓" : "✗"} ${step}${data.note ? ` — ${data.note}` : ""}`);
}

function resultText(json) {
	return Array.isArray(json?.content) ? json.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join(" ") : "";
}
function envelopeError(json) {
	const text = resultText(json);
	try {
		const env = JSON.parse(text);
		const err = env?.error ?? env;
		return String(err?.code ?? err?.error_code ?? err?.message ?? text).slice(0, 160);
	} catch {
		return text.slice(0, 160);
	}
}

async function invoke(info, tool, params) {
	return controlRequest(info, "POST", "/invoke", { tool, params, cwd: process.cwd() });
}

let exitCode = 0;
const handle = await startDaemon({ writeLock: false });
const info = { controlHost: handle.controlHost, controlPort: handle.controlPort, token: handle.token };
try {
	const status = await controlRequest(info, "GET", "/status");
	record("daemon /status", status.json?.ok === true, { note: `${status.json?.tools} tools` });

	// The decisive end-to-end proof: evaluate 2+2 in the live page through the CLI path.
	const exec = await invoke(info, "browser_execute", { script: "2 + 2" });
	if (exec.json?.terminate) {
		record("browser_execute 2+2", false, { note: `no browser? ${envelopeError(exec.json)}` });
		exitCode = 3;
	} else {
		const text = resultText(exec.json);
		const ok = text.includes("4");
		record("browser_execute 2+2", ok, { note: ok ? "evaluated in the live tab" : `unexpected: ${text.slice(0, 120)}` });
		if (!ok) exitCode = 1;
	}

	// Secondary: observe scan exercises the ABML perception path through the CLI.
	if (exitCode === 0) {
		const observe = await invoke(info, "browser_observe", { mode: "scan" });
		record("browser_observe scan", observe.json?.terminate !== true, { note: observe.json?.terminate ? envelopeError(observe.json) : "scanned" });
		if (observe.json?.terminate) exitCode = 3;
	}
} catch (error) {
	record("smoke", false, { note: error instanceof Error ? error.message : String(error) });
	exitCode = 1;
} finally {
	await handle.close();
}

if (exitCode === 3) {
	console.error("\n⚠ NEEDS BROWSER — load the extension, open a tab, then re-run: npm run smoke:cli");
} else if (exitCode === 0) {
	console.log("\nsmoke-cli PASS — CLI → daemon → bridge → browser path verified end-to-end.");
} else {
	console.error("\nsmoke-cli FAIL");
}
process.exit(exitCode);
