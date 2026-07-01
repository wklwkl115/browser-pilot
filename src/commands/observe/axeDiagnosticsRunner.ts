import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { compactError } from "../../utils/errors.js";
import { stableJson, truncateText } from "../../utils/json.js";
import { isRecord } from "../../utils/params.js";
import { redactSensitiveText } from "../../utils/redaction.js";

const DEFAULT_AXE_TIMEOUT_MS = 4_000;
const MIN_AXE_TIMEOUT_MS = 250;
const DEFAULT_MAX_RESULTS = 10;
const MAX_SAFE_TEXT_CHARS = 240;
const AXE_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../node_modules/axe-core/axe.min.js");
let axeScriptCache: string | undefined;

export type AxeProviderStatus = "executed" | "skipped" | "failed" | "degraded";

export type AxeDiagnosticsSummary = {
	provider: "axe";
	status: AxeProviderStatus;
	requested: boolean;
	timedOut?: boolean;
	degraded?: boolean;
	ms?: number;
	testEngine?: Record<string, unknown>;
	counts?: Record<string, number>;
	impactCounts?: Record<string, number>;
	ruleCounts?: Record<string, number>;
	bounded?: { maxInlineResults: number };
	samples?: Array<Record<string, unknown>>;
	artifact?: { path: string; jsonPath: string; kind: "axe-core-diagnostics" };
	error?: Record<string, unknown>;
};

export type AxeDiagnosticsResult = {
	status: AxeProviderStatus;
	summary: AxeDiagnosticsSummary;
	artifact?: Record<string, unknown>;
	failure?: {
		provider: "axe";
		code: string;
		message?: string;
		details?: Record<string, unknown>;
	};
};

type AxeRunOptions = {
	requested?: boolean;
	timeoutMs?: number;
	maxResults?: number;
	browserSessionId?: string;
	tabId?: number | string;
	artifactPath?: string;
};

function normalizedTimeoutMs(value: unknown): number {
	const n = Number(value ?? DEFAULT_AXE_TIMEOUT_MS);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_AXE_TIMEOUT_MS;
	return Math.max(MIN_AXE_TIMEOUT_MS, Math.min(DEFAULT_AXE_TIMEOUT_MS, Math.floor(n)));
}

function normalizedMaxResults(value: unknown): number {
	const n = Number(value ?? DEFAULT_MAX_RESULTS);
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
	return Math.max(1, Math.min(50, Math.floor(n)));
}

function safeString(value: unknown, maxChars = MAX_SAFE_TEXT_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = redactSensitiveText(value.replace(/\s+/g, " ").trim());
	if (!compact) return undefined;
	return truncateText(compact, maxChars).text;
}

function countBy(items: Array<Record<string, unknown>>, key: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of items) {
		const raw = item[key];
		const value = typeof raw === "string" && raw.trim() ? raw.trim() : "unknown";
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function sampleIssues(violations: Array<Record<string, unknown>>, maxResults: number): Array<Record<string, unknown>> {
	const samples: Array<Record<string, unknown>> = [];
	for (const violation of violations) {
		const nodes = Array.isArray(violation.nodes) ? violation.nodes.filter(isRecord) as Array<Record<string, unknown>> : [];
		const firstNode = nodes[0];
		const target = Array.isArray(firstNode?.target) ? firstNode.target.filter((item): item is string => typeof item === "string").slice(0, 3) : undefined;
		const any = Array.isArray(firstNode?.any) ? firstNode.any : undefined;
		const all = Array.isArray(firstNode?.all) ? firstNode.all : undefined;
		const none = Array.isArray(firstNode?.none) ? firstNode.none : undefined;
		samples.push({
			id: safeString(violation.id, 120),
			impact: safeString(violation.impact, 40),
			description: safeString(violation.description),
			help: safeString(violation.help),
			helpUrl: safeString(violation.helpUrl, 200),
			...(target?.length ? { target } : {}),
			...(any ? { anyCount: any.length } : {}),
			...(all ? { allCount: all.length } : {}),
			...(none ? { noneCount: none.length } : {}),
		});
		if (samples.length >= maxResults) break;
	}
	return samples;
}

function axeRunExpression(axeSource: string, options: { timeoutMs: number; maxResults: number }): string {
	return `(() => {
const axeSource = ${JSON.stringify(axeSource)};
const options = ${stableJson(options)};
return Promise.race([
  (async () => {
    if (!globalThis.axe || typeof globalThis.axe.run !== "function") {
      (0, eval)(axeSource);
    }
    if (!globalThis.axe || typeof globalThis.axe.run !== "function") throw new Error("axe-core did not initialize");
    const startedAt = Date.now();
    const result = await globalThis.axe.run(document, { resultTypes: ["violations", "incomplete", "inapplicable", "passes"] });
    return { ok: true, elapsedMs: Date.now() - startedAt, result };
  })(),
  new Promise(resolve => setTimeout(() => resolve({ ok: false, timedOut: true, elapsedMs: options.timeoutMs, error: { code: "AXE_TIMEOUT", message: "axe-core diagnostics timed out" } }), options.timeoutMs))
]);
})()`;
}

async function loadAxeScript(): Promise<string> {
	axeScriptCache ??= await readFile(AXE_SCRIPT_PATH, "utf8");
	return axeScriptCache;
}

function normalizeAxePayload(payload: unknown, options: { requested: boolean; maxResults: number; artifactPath?: string }): AxeDiagnosticsResult {
	if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.result)) {
		const payloadRecord = isRecord(payload) ? payload : {};
		const timedOut = payloadRecord.timedOut === true;
		const error = isRecord(payloadRecord.error) ? payloadRecord.error : payloadRecord;
		const code = timedOut ? "AXE_TIMEOUT" : typeof error.code === "string" ? error.code : "AXE_FAILED";
		const message = typeof error.message === "string" ? error.message : timedOut ? "axe-core diagnostics timed out" : "axe-core diagnostics failed";
		return {
			status: timedOut ? "degraded" : "failed",
			summary: { provider: "axe", requested: options.requested, status: timedOut ? "degraded" : "failed", timedOut, degraded: timedOut, error: { code, message } },
			failure: { provider: "axe", code, message },
		};
	}
	const result = payload.result;
	const violations = Array.isArray(result.violations) ? result.violations.filter(isRecord) as Array<Record<string, unknown>> : [];
	const incomplete = Array.isArray(result.incomplete) ? result.incomplete.filter(isRecord) as Array<Record<string, unknown>> : [];
	const passes = Array.isArray(result.passes) ? result.passes.filter(isRecord) as Array<Record<string, unknown>> : [];
	const inapplicable = Array.isArray(result.inapplicable) ? result.inapplicable.filter(isRecord) as Array<Record<string, unknown>> : [];
	const elapsedMs = typeof payload.elapsedMs === "number" ? payload.elapsedMs : undefined;
	const counts = { violations: violations.length, incomplete: incomplete.length, passes: passes.length, inapplicable: inapplicable.length };
	const summary: AxeDiagnosticsSummary = {
		provider: "axe",
		requested: options.requested,
		status: incomplete.length ? "degraded" : "executed",
		...(incomplete.length ? { degraded: true } : {}),
		...(elapsedMs !== undefined ? { ms: elapsedMs } : {}),
		...(isRecord(result.testEngine) ? { testEngine: { name: result.testEngine.name, version: result.testEngine.version } } : {}),
		counts,
		impactCounts: countBy(violations, "impact"),
		ruleCounts: countBy(violations, "id"),
		bounded: { maxInlineResults: options.maxResults },
		samples: sampleIssues(violations, options.maxResults),
		...(options.artifactPath ? { artifact: { path: options.artifactPath, jsonPath: "axe", kind: "axe-core-diagnostics" } } : {}),
	};
	return {
		status: summary.status,
		summary,
		artifact: {
			provider: "axe",
			result,
			summary,
			bounded: { maxInlineResults: options.maxResults },
		},
	};
}

export function shouldRunAxeDiagnostics(params: { diagnostics?: unknown; debug?: unknown; axe?: unknown; axeDiagnostics?: unknown; params?: unknown }): boolean {
	if (params.axe === true || params.axeDiagnostics === true) return true;
	if (params.diagnostics === "axe" || params.diagnostics === "accessibility") return true;
	if (params.debug === "axe" || params.debug === "accessibility") return true;
	const nested = isRecord(params.params) ? params.params : undefined;
	return nested?.axe === true || nested?.axeDiagnostics === true || nested?.diagnostics === "axe" || nested?.diagnostics === "accessibility";
}

export async function runAxeDiagnostics(server: Pick<BrowserCommandRuntimePort, "sendCommand">, options: AxeRunOptions): Promise<AxeDiagnosticsResult> {
	if (options.requested !== true) return { status: "skipped", summary: { provider: "axe", status: "skipped", requested: false } };
	const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
	const maxResults = normalizedMaxResults(options.maxResults);
	try {
		const script = axeRunExpression(await loadAxeScript(), { timeoutMs, maxResults });
		const result = await evaluatePageScriptDirect(server, script, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: timeoutMs + 500, name: "browser_observe.axeDiagnostics" });
		return normalizeAxePayload(result.data, { requested: true, maxResults, artifactPath: options.artifactPath });
	} catch (error) {
		const compact = compactError(error, "AXE_FAILED");
		const code = typeof compact.code === "string" ? compact.code : "AXE_FAILED";
		const message = typeof compact.message === "string" ? compact.message : "axe-core diagnostics failed";
		const details = isRecord(compact.details) ? compact.details : undefined;
		return {
			status: "failed",
			summary: { provider: "axe", requested: true, status: "failed", error: { code, message, ...(details ? { details } : {}) } },
			failure: { provider: "axe", code, message, ...(details ? { details } : {}) },
		};
	}
}
