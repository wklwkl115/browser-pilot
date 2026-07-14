import { invokeTool } from "./client.js";
import { looksLikeToolError, writeJsonEnvelope, EXIT, type RenderMode, type ToolResultLike } from "./render.js";
import { isRecord } from "../../utils/records.js";
import { renderUsageError } from "./render.js";
import { jsonMode, renderLocalJson } from "./cliBasics.js";

function compactText(text: string): string {
	return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function toolResultText(result: ToolResultLike): string {
	return result.content.map((item) => item.text).join("\n");
}

function parseSelftestJson(text: string, step: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) return parsed;
	} catch {
		/* handled below */
	}
	throw new Error(`${step} returned non-JSON output: ${compactText(text)}`);
}

function envelopeMessage(env: Record<string, unknown>, fallback: string): string {
	const nested = isRecord(env.error) ? env.error : undefined;
	if (typeof nested?.message === "string") return nested.message;
	if (typeof env.message === "string") return env.message;
	if (typeof env.error === "string") return env.error;
	return typeof env.code === "string" ? `${env.code}: ${fallback}` : fallback;
}

export function selftestToolError(result: ToolResultLike): string | undefined {
	const text = toolResultText(result);
	if (result.terminate !== true && !looksLikeToolError(text)) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? envelopeMessage(parsed, compactText(text)) : compactText(text);
	} catch {
		return compactText(text);
	}
}

function requireSelftestToolOk(step: string, result: ToolResultLike): string {
	const error = selftestToolError(result);
	if (error) throw new Error(`${step} failed: ${error}`);
	return toolResultText(result);
}

function jsonFailure(message: string, steps: Array<Record<string, unknown>>): number {
	writeJsonEnvelope({ ok: false, exitCode: EXIT.toolError, code: "CLI_SELFTEST_FAILED", message, command: "selftest", steps });
	return EXIT.toolError;
}

function requireConfirm(argv: string[], mode: RenderMode): number | undefined {
	return argv.includes("--confirm") ? undefined : renderUsageError("selftest may create and close a temporary tab; rerun with --confirm", mode);
}

export async function runSelftestCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const confirmation = requireConfirm(argv, mode);
	if (confirmation !== undefined) return confirmation;
	const steps: Array<Record<string, unknown>> = [];
	let tabId: number | undefined;
	try {
		tabId = await createSelftestTab(steps);
		await executeSelftest(tabId, steps);
		await observeSelftest(tabId, steps);
		await closeSelftestTab(tabId, steps);
		if (mode === "json") return renderLocalJson({ command: "selftest", steps, passed: steps.every((step) => step.ok === true) });
		process.stdout.write("selftest PASS\n");
		return EXIT.ok;
	} catch (error) {
		await cleanupSelftestTab(tabId, steps);
		const message = error instanceof Error ? error.message : String(error);
		if (mode === "json") return jsonFailure(message, steps);
		process.stderr.write(`selftest FAIL: ${message}\n`);
		return EXIT.toolError;
	}
}

async function createSelftestTab(steps: Array<Record<string, unknown>>): Promise<number> {
	const create = await invokeTool("browser_tabs", { action: "create", url: "about:blank", active: true }, process.cwd());
	const createEnv = parseSelftestJson(requireSelftestToolOk("create-temp-tab", create), "create-temp-tab") as { schema?: string; status?: string; completionVerified?: boolean; target?: { tabId?: number } };
	if (createEnv.schema !== "browser-operation/v2" || createEnv.status !== "completed" || createEnv.completionVerified !== true) throw new Error(`create-temp-tab did not complete: ${compactText(JSON.stringify(createEnv))}`);
	const tabId = createEnv.target?.tabId;
	steps.push({ step: "create-temp-tab", ok: typeof tabId === "number", tabId });
	if (typeof tabId !== "number") throw new Error("selftest could not create a temporary tab");
	return tabId;
}

async function executeSelftest(tabId: number, steps: Array<Record<string, unknown>>): Promise<void> {
	const exec = await invokeTool("browser_execute", {
		tabId,
		intentId: `browser-pilot-selftest-${process.pid}-${Date.now()}`,
		script: "document.title='Browser Pilot Selftest';document.body.textContent='browser-pilot selftest ok';({title:document.title,text:document.body.textContent})",
		postcondition: "document.title === 'Browser Pilot Selftest' && document.body.textContent === 'browser-pilot selftest ok'",
	}, process.cwd());
	const execText = requireSelftestToolOk("execute", exec);
	const execOutcome = parseSelftestJson(execText, "execute") as { schema?: string; status?: string; completionVerified?: boolean };
	const ok = execOutcome.schema === "browser-operation/v2" && execOutcome.status === "completed" && execOutcome.completionVerified === true && execText.includes("browser-pilot selftest ok");
	steps.push({ step: "execute", ok });
	if (!ok) throw new Error(`execute did not return expected marker: ${compactText(execText)}`);
}

async function observeSelftest(tabId: number, steps: Array<Record<string, unknown>>): Promise<void> {
	const observe = await invokeTool("browser_observe", { tabId, mode: "text", maxNodes: 50 }, process.cwd());
	const observeText = requireSelftestToolOk("observe-text", observe);
	const ok = observeText.includes("browser-pilot selftest ok");
	steps.push({ step: "observe-text", ok });
	if (!ok) throw new Error(`observe-text did not return expected marker: ${compactText(observeText)}`);
}

async function closeSelftestTab(tabId: number, steps: Array<Record<string, unknown>>): Promise<void> {
	const close = await invokeTool("browser_tabs", { action: "close", tabId }, process.cwd());
	const closeOutcome = parseSelftestJson(requireSelftestToolOk("close-temp-tab", close), "close-temp-tab") as { schema?: string; status?: string; completionVerified?: boolean };
	if (closeOutcome.schema !== "browser-operation/v2" || closeOutcome.status !== "completed" || closeOutcome.completionVerified !== true) throw new Error(`close-temp-tab did not complete: ${compactText(JSON.stringify(closeOutcome))}`);
	steps.push({ step: "close-temp-tab", ok: true, tabId });
}

async function cleanupSelftestTab(tabId: number | undefined, steps: Array<Record<string, unknown>>): Promise<void> {
	if (tabId === undefined) return;
	try {
		await invokeTool("browser_tabs", { action: "close", tabId }, process.cwd());
		steps.push({ step: "cleanup-temp-tab", ok: true, tabId });
	} catch {
		steps.push({ step: "cleanup-temp-tab", ok: false, tabId });
	}
}
