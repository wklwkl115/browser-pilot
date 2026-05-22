import { Type } from "typebox";
import { BrowserBridgeError } from "../driver/errors";
import { summarizeOrchestrationData } from "./summaries/orchestration";
import { defaultResultBudget } from "./budgets";
import { artifactFallbackName, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolTimeoutMs } from "./toolAdapter";
import { DEFAULT_OBSERVATION_TIMEOUT_MS } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

const ORCHESTRATE_ACTIONS = new Set(["plan", "apply", "status", "watch", "stop", "delete"]);

type OrchestrateParams = {
	action?: string;
	desiredState?: unknown;
	orchestrationId?: string;
	dryRun?: boolean;
	watch?: { intervalMs?: number; ttlMs?: number; maxAttempts?: number };
	cleanup?: boolean;
	timeoutMs?: number;
	detailLevel?: string;
	outputPath?: string;
	maxChars?: number;
};

function normalizeAction(value: unknown): "plan" | "apply" | "status" | "watch" | "stop" | "delete" {
	const action = String(value || "status").trim();
	if (!ORCHESTRATE_ACTIONS.has(action)) throw new BrowserBridgeError("ORCHESTRATION_INVALID_DESIRED", "browser_orchestrate action must be one of plan, apply, status, watch, stop, delete", { action });
	return action as "plan" | "apply" | "status" | "watch" | "stop" | "delete";
}

function requireDesiredState(params: OrchestrateParams, action: string): unknown {
	if (params.desiredState === undefined || params.desiredState === null) throw new BrowserBridgeError("ORCHESTRATION_INVALID_DESIRED", `browser_orchestrate ${action} requires desiredState`, { action });
	return params.desiredState;
}

function requireOrchestrationId(params: OrchestrateParams, action: string): string {
	const id = typeof params.orchestrationId === "string" ? params.orchestrationId.trim() : "";
	if (!id) throw new BrowserBridgeError("ORCHESTRATION_INVALID_DESIRED", `browser_orchestrate ${action} requires orchestrationId`, { action });
	return id;
}

function watchOptions(params: OrchestrateParams, timeoutMs: number) {
	const watch = params.watch && typeof params.watch === "object" && !Array.isArray(params.watch) ? params.watch : {};
	return {
		timeoutMs,
		intervalMs: watch.intervalMs,
		ttlMs: watch.ttlMs,
		maxAttempts: watch.maxAttempts,
	};
}

export function registerOrchestrateTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_orchestrate",
		label: "Browser Orchestration",
		description: "Reconcile declared browser session state across owned tabs/windows, visual grouping, pre-navigation document-start hooks, navigation, cookies, network recorder, hook dispatcher, sessionAssertions readiness checks, status, watch, and cleanup.",
		promptSnippet: "Declare browser session state for the Node driver coordinator to reconcile across plan/apply/status/watch/stop/delete, including registry-backed preNavigationHooks and sessionAssertions readiness checks; readinessChecks remains a descriptive alias only, not a schema field.",
		promptGuidelines: [
			"Use browser_orchestrate for declarative browser session reconciliation; do not use it to encode click sequences, form-filling steps, site-specific scripts, or workflow DSL.",
			"Use browser_execute/browser_scan/browser_wait for site-specific page observation, selector checks, and workflow execution before or after reconciliation.",
			"Use sessionAssertions for declarative readiness checks only. They may verify url/origin/loadState, cookie/storage presence or hash, selector/text/attribute, hook/network/profile state, but they must not contain click steps, workflow DSL, readinessChecks alias, or script/code/source.",
			"Keep desiredState scoped with explicit sessions, tabs, URLs, allowedOrigins, ownedWindow/visualGrouping/preNavigationHooks intent, sessionAssertions, and cleanup policy. Cookie values are redacted from summaries/artifacts by default; pre-navigation hook script bytes are never persisted.",
			"Use plan or dryRun before apply/watch when target ownership, reuse, cookies, window creation, visual grouping, pre-navigation hooks, network recorder, or hook effects need review.",
			"Treat tabGroups degraded status as diagnostic; it must not block core tab/window/navigation/cookie/network/hook reconcile.",
			"Use preNavigationHooks only with registry-backed hookId/version/hash metadata; desiredState must not contain script/code/source fields.",
			"Persistent state loaded after restart is read-only until desiredState.adoption explicitly verifies origins, URLs, resourceTypes, and ownership fingerprints.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "plan | apply | status | watch | stop | delete. Default status." }),
			desiredState: Type.Optional(Type.Any({ description: "Declared browser session state for plan/apply/watch. apiVersion pi.browser/v1, sessions, tabs, ownedWindow/windowIsolation, visualGrouping, preNavigationHooks registry metadata, cookies, networkRecorder, hookDispatcher, sessionAssertions readiness checks, allowedOrigins, cleanup policy. Do not put click steps, workflow DSL, readinessChecks alias, or script/code/source fields here." })),
			orchestrationId: Type.Optional(Type.String({ description: "Logical orchestration id for status/stop/delete or desiredState override." })),
			dryRun: Type.Optional(Type.Boolean({ description: "For apply/watch/delete, return a non-mutating plan/status preview instead of applying side effects." })),
			watch: Type.Optional(Type.Object({
				intervalMs: Type.Optional(Type.Number({ description: "watch only: reconcile interval in milliseconds, clamped by coordinator." })),
				ttlMs: Type.Optional(Type.Number({ description: "watch only: total watch TTL in milliseconds, clamped by coordinator." })),
				maxAttempts: Type.Optional(Type.Number({ description: "watch only: maximum consecutive failed reconcile attempts before pause." })),
			})),
			cleanup: Type.Optional(Type.Boolean({ description: "delete only: cleanup owned resources. false is rejected to avoid orphaning coordinator-owned tabs/windows/recorders/hooks." })),
			...sharedTabScopedToolParams({ includeTabId: false }),
		}),
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const params = rawParams as OrchestrateParams;
				const action = normalizeAction(params.action);
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_OBSERVATION_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_orchestrate");
				const server = await ensureStarted();
				const coordinator = server.orchestrator();
				let result: unknown;
				if (action === "plan") result = await coordinator.plan(requireDesiredState(params, action), { timeoutMs });
				else if (action === "apply") result = params.dryRun ? await coordinator.plan(requireDesiredState(params, action), { timeoutMs }) : await coordinator.apply(requireDesiredState(params, action), { timeoutMs });
				else if (action === "watch") result = params.dryRun ? await coordinator.plan(requireDesiredState(params, action), { timeoutMs }) : await coordinator.watch(requireDesiredState(params, action), watchOptions(params, timeoutMs));
				else if (action === "status") result = await coordinator.status(params.orchestrationId, { timeoutMs });
				else if (action === "stop") result = await coordinator.stop(requireOrchestrationId(params, action), { timeoutMs });
				else {
					if (params.cleanup === false) throw new BrowserBridgeError("ORCHESTRATION_INVALID_DESIRED", "browser_orchestrate delete cleanup:false is not allowed for owned resources", { action, orchestrationId: params.orchestrationId });
					result = params.dryRun ? await coordinator.status(requireOrchestrationId(params, action), { timeoutMs }) : await coordinator.delete(requireOrchestrationId(params, action), { timeoutMs });
				}
				return await jsonToolResult(result, params, ctx, {
					toolName: "browser_orchestrate",
					budgetName: "browser_orchestrate",
					command: `orchestration.${action}`,
					defaultDetailLevel: "summary",
					maxChars,
					fallbackName: artifactFallbackName("orchestration-result"),
					details: { action },
					artifactValue: result,
					distill: summarizeOrchestrationData,
					artifactThreshold: Math.min(defaultResultBudget("browser_orchestrate"), 16_000),
				});
			});
		},
	});
}
