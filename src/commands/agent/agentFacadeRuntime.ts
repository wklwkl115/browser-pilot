import { getAgentContextService } from "../../apps/daemon/AgentContextService.js";
import type { AgentContextPort } from "../../browser-runtime/ports/AgentContextPort.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import type { PageObservationV3 } from "../../kernels/abml/pageObservation.js";
import { PAGE_OBSERVATION_SCHEMA_V3, isPageObservationV3 } from "../../kernels/abml/pageObservation.js";
import { identityFromObservation, projectAgentView } from "../../kernels/agent/agentView.js";
import type {
	AgentContextRecord,
	AgentReadOption,
	AgentTargetCandidate,
	AgentViewV1,
	BrowserAgentContextSummary,
} from "../../kernels/agent/agentTypes.js";
import { AGENT_VIEW_SCHEMA } from "../../kernels/agent/agentTypes.js";
import { isRecord } from "../../utils/records.js";
import { agentError } from "./agentErrors.js";
import { failClosedAgentView } from "./agentEnvelopeSanitize.js";

export function resolveAgentOwner(ctx: { operationOwnerId?: string } | undefined): string {
	return ctx?.operationOwnerId?.trim() || "local-cli";
}

export function agentContextPort(): AgentContextPort {
	return getAgentContextService();
}

export function contextSummary(record: AgentContextRecord, pageChanged = false): BrowserAgentContextSummary {
	return {
		contextRef: record.id,
		contextRevision: record.revision,
		state: record.state,
		pageChanged,
	};
}

export async function ensureRuntimeReady(server: BrowserCommandRuntimePort): Promise<"reused" | "started"> {
	const snapshot = server.snapshot({});
	if (snapshot.running && snapshot.extensionConnected) return "reused";
	// ensureStarted already invoked by caller; if still not connected, surface readiness error.
	if (!snapshot.extensionConnected) {
		throw agentError("RUNTIME_NOT_READY", "browser extension is not connected; run browser-pilot doctor", {
			extensionConnected: snapshot.extensionConnected,
			running: snapshot.running,
		});
	}
	return "reused";
}

export function loadObservationFromCommandResult(result: { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }): PageObservationV3 | undefined {
	const text = result.content?.find((part) => part.type === "text")?.text;
	if (text) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (isPageObservationV3(parsed)) return parsed;
			if (isRecord(parsed) && isRecord(parsed.data) && isPageObservationV3(parsed.data)) return parsed.data as PageObservationV3;
		} catch {
			/* fall through */
		}
	}
	const details = result.details;
	if (isRecord(details)) {
		if (isPageObservationV3(details)) return details;
		if (isRecord(details.data) && isPageObservationV3(details.data)) return details.data as PageObservationV3;
		if (isRecord(details.observation) && isPageObservationV3(details.observation)) return details.observation as PageObservationV3;
	}
	return undefined;
}

export function extractJsonPayload(result: { content?: Array<{ type: string; text?: string }> }): unknown {
	const text = result.content?.find((part) => part.type === "text")?.text;
	if (!text) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

export type AgentObserveRunner = (
	server: BrowserCommandRuntimePort,
	options: {
		browserSessionId?: string;
		tabId?: number;
		targetRef?: string;
		timeoutMs: number;
	},
) => Promise<PageObservationV3>;

let observeRunner: AgentObserveRunner | undefined;

/** Test-only injection for handler-driven façades without a live page capture. */
export function setAgentObserveRunnerForTests(runner: AgentObserveRunner | undefined): void {
	observeRunner = runner;
}

export async function runCanonicalObserve(
	server: BrowserCommandRuntimePort,
	options: {
		browserSessionId?: string;
		tabId?: number;
		targetRef?: string;
		timeoutMs: number;
	},
): Promise<PageObservationV3> {
	if (observeRunner) return observeRunner(server, options);
	// Invoke observe path through the same server the command runtime uses.
	const { defineObserveCommand } = await import("../observeCommand.js");
	const { CommandManifestIndex } = await import("../commandManifestIndex.js");
	const index = new CommandManifestIndex();
	defineObserveCommand({
		commands: index,
		ensureStarted: async () => server,
	});
	const observe = index.getCommand("browser_observe");
	if (!observe) throw agentError("RUNTIME_NOT_READY", "browser_observe is not registered");
	const result = await observe.execute(
		"agent-view-observe",
		{
			timeoutMs: options.timeoutMs,
			...(options.browserSessionId ? { browserSessionId: options.browserSessionId } : {}),
			...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
			...(options.targetRef ? { targetRef: options.targetRef } : {}),
		},
		undefined,
		undefined,
		{ omitTransportDetails: true },
	);
	const observation = loadObservationFromCommandResult(result);
	if (!observation) {
		throw agentError("RUNTIME_NOT_READY", "browser_observe did not return PageObservationV3", {
			schemaExpected: PAGE_OBSERVATION_SCHEMA_V3,
		});
	}
	return observation;
}

export function listTargetCandidates(
	server: BrowserCommandRuntimePort,
	record: AgentContextRecord,
	browserSessionId?: string,
): AgentTargetCandidate[] {
	const snapshot = server.snapshot({ browserSessionId });
	const tabs = snapshot.tabs ?? [];
	const targets = tabs.map((tab, index) => {
		const lineage = typeof tab.targetRef === "string"
			? tab.targetRef
			: typeof tab.tabHandle === "string"
				? tab.tabHandle
				: `tab:${tab.tabId ?? index}`;
		return {
			targetLineageRef: lineage,
			tabId: typeof tab.tabId === "number" ? tab.tabId : undefined,
			title: typeof tab.title === "string" ? tab.title : undefined,
			url: typeof tab.url === "string" ? tab.url : undefined,
			active: tab.active === true,
		};
	});
	const port = agentContextPort();
	const bindings = port.replaceTargetBindings(record, targets);
	const currentLineage = record.targetLineageRef;
	return [...bindings.values()].map((binding) => ({
		tabRef: binding.tabRef,
		title: binding.title,
		url: binding.url,
		active: targets.find((t) => t.targetLineageRef === binding.targetLineageRef)?.active === true,
		current: currentLineage ? binding.targetLineageRef === currentLineage : false,
		actions: ["view"] as ["view"],
	}));
}

export function projectAndBindView(input: {
	observation: PageObservationV3;
	record: AgentContextRecord;
	detail?: "decision" | "expanded";
	maxChars?: number;
	targets?: AgentTargetCandidate[];
	pageTitle?: string;
}): AgentViewV1 {
	const port = agentContextPort();
	const identity = identityFromObservation(input.observation);
	const applied = port.applyIdentity(input.record, identity, input.observation.reanchorReason);
	if (identity) input.record.pageIdentity = identity;
	if (input.observation.snapshot.snapshotId) {
		input.record.snapshotId = input.observation.snapshot.snapshotId;
		input.record.baselineSnapshotId = input.observation.snapshot.snapshotId;
	}
	if (identity) {
		input.record.targetLineageRef = `${identity.browserSessionId}:${identity.tabId}:${identity.targetGeneration}`;
	}

	const reads: AgentReadOption[] = [];
	if (input.observation.saved?.path) {
		const read = port.bindRead(input.record, {
			source: "observation_frontier",
			kind: "content",
			pageIdentity: identity,
			descriptor: {
				savedPath: input.observation.saved.path,
				description: "canonical observation artifact",
			},
		});
		reads.push({
			readRef: read.readRef,
			kind: "content",
			description: "canonical observation artifact",
		});
	}
	const frontierItems = input.observation.frontier?.items;
	if (Array.isArray(frontierItems) && frontierItems.length) {
		const read = port.bindRead(input.record, {
			source: "observation_frontier",
			kind: "collection",
			pageIdentity: identity,
			descriptor: {
				description: `observation frontier (${frontierItems.length} items)`,
				inlineData: { itemCount: frontierItems.length },
			},
		});
		reads.push({
			readRef: read.readRef,
			kind: "collection",
			description: `observation frontier (${frontierItems.length} items)`,
			estimatedItems: frontierItems.length,
		});
	}

	const { view, candidateBindings } = projectAgentView({
		observation: input.observation,
		context: input.record,
		detail: input.detail,
		maxChars: input.maxChars,
		targets: input.targets,
		reads,
		pageTitle: input.pageTitle,
		trace: { available: false, unavailableReason: "trace_metadata_not_persisted" },
	});

	if (input.record.pageIdentity) {
		port.replaceCandidateBindings(
			input.record,
			candidateBindings.map((b) => ({
				resourceRef: b.resourceRef,
				role: b.role,
				label: b.label,
				actions: b.actions,
			})),
		);
		// re-align aliases on view with registry after replace (replace regenerates a_01…)
		const rebound = [...input.record.candidateBindings.values()];
		view.candidates = rebound.map((b) => ({
			ref: b.ref,
			role: b.role,
			...(b.label ? { label: b.label } : {}),
			actions: b.allowedActions,
			state: { visible: true },
		}));
		if (view.decision.kind === "choose_action") {
			view.decision = {
				kind: "choose_action",
				candidateRefs: view.candidates.slice(0, 8).map((c) => c.ref),
			};
		}
	}

	view.context = {
		...view.context,
		contextRef: input.record.id,
		contextRevision: input.record.revision,
		state: input.record.state,
		pageChanged: Boolean(applied.reanchorReason) || view.page.changed,
		...(applied.reanchorReason ? { reanchorReason: applied.reanchorReason } : {}),
	};
	view.schema = AGENT_VIEW_SCHEMA;
	port.touch(input.record);
	return failClosedAgentView(view as unknown as Record<string, unknown>) as unknown as typeof view;
}
