import type { PageObservationV3 } from "../abml/pageObservation.js";
import { jsonCost } from "../evidence/cost.js";
import type { PageIdentity } from "../session/pageIdentity.js";
import { pageReanchorReason } from "../session/pageIdentity.js";
import { decideAfterView } from "./agentDecision.js";
import { candidateActionsForRole } from "./semanticAction.js";
import {
	AGENT_CONTEXT_BOUNDS,
	AGENT_VIEW_SCHEMA,
	type AgentCandidate,
	type AgentCandidateAction,
	type AgentChangeSummary,
	type AgentContextRecord,
	type AgentNotice,
	type AgentReadOption,
	type AgentTargetCandidate,
	type AgentViewV1,
	type BrowserAgentContextSummary,
} from "./agentTypes.js";

export type AgentFocus = {
	text?: string;
	roles?: string[];
	include?: Array<"notices" | "forms" | "navigation" | "content">;
};

export type AgentViewProjectionInput = {
	observation: PageObservationV3;
	context: Pick<AgentContextRecord, "id" | "revision" | "state" | "pageIdentity">;
	focus?: AgentFocus;
	detail?: "decision" | "expanded";
	maxChars?: number;
	targets?: AgentTargetCandidate[];
	reads?: AgentReadOption[];
	trace?: AgentViewV1["trace"];
	automaticReanchorReason?: string;
	pageTitle?: string;
	/** Blocking control refs that must appear even under budget. */
	blockingRefs?: string[];
	actionRef?: string;
};

function roleFromKind(kind: string): string {
	const k = kind.toLowerCase();
	if (k.includes("button")) return "button";
	if (k.includes("link") || k === "a") return "link";
	if (k.includes("text") || k === "input" || k === "textarea") return "textbox";
	if (k.includes("select") || k === "listbox") return "listbox";
	if (k.includes("checkbox")) return "checkbox";
	if (k.includes("radio")) return "radio";
	if (k.includes("combobox")) return "combobox";
	return kind || "generic";
}

function stateFromActionable(state: Record<string, unknown> | undefined): AgentCandidate["state"] {
	if (!state) return { visible: true };
	return {
		visible: state.visible !== false && state.hidden !== true,
		enabled: state.disabled === true || state.enabled === false ? false : true,
		editable: state.editable === true || state.readonly === true ? state.editable === true && state.readonly !== true : undefined,
		selected: typeof state.selected === "boolean" ? state.selected : undefined,
		expanded: typeof state.expanded === "boolean" ? state.expanded : undefined,
	};
}

export function projectActionableToCandidate(
	actionable: { ref: string; kind: string; name?: string; state?: Record<string, unknown> },
	alias: string,
): AgentCandidate {
	const role = roleFromKind(actionable.kind);
	const state = stateFromActionable(actionable.state);
	const actions = candidateActionsForRole(role, state) as AgentCandidateAction[];
	return {
		ref: alias,
		role,
		...(actionable.name ? { label: actionable.name } : {}),
		state,
		actions,
	};
}

function buildNotices(observation: PageObservationV3): AgentNotice[] {
	const notices: AgentNotice[] = [];
	const diagnostics = observation.diagnostics;
	if (diagnostics && typeof diagnostics === "object") {
		const errors = (diagnostics as { errors?: unknown }).errors;
		if (Array.isArray(errors)) {
			for (const err of errors.slice(0, 4)) {
				const message = typeof err === "string" ? err : JSON.stringify(err);
				notices.push({ kind: "error", message: message.slice(0, 200) });
			}
		}
	}
	if (observation.reanchorReason) {
		notices.push({ kind: "target_change", message: `page reanchor: ${observation.reanchorReason}` });
	}
	return notices.slice(0, AGENT_CONTEXT_BOUNDS.l0MaxNotices);
}

function buildSummary(observation: PageObservationV3, candidates: AgentCandidate[], notices: AgentNotice[]): string {
	const gist = observation.gist && typeof observation.gist === "object"
		? String((observation.gist as { text?: string }).text ?? (observation.gist as { summary?: string }).summary ?? "")
		: "";
	const title = typeof observation.gist === "object" && observation.gist && "title" in observation.gist
		? String((observation.gist as { title?: string }).title ?? "")
		: "";
	const parts = [
		title || undefined,
		gist || undefined,
		candidates.length ? `${candidates.length} actionable candidate(s)` : "no actionable candidates",
		notices.length ? `${notices.length} notice(s)` : undefined,
	].filter(Boolean);
	return parts.join(" — ").slice(0, 400) || "Page observed.";
}

function pinOrder(
	actionables: Array<{ ref: string; kind: string; name?: string; state?: Record<string, unknown> }>,
	blockingRefs: string[],
	actionRef?: string,
): typeof actionables {
	const byRef = new Map(actionables.map((a) => [a.ref, a]));
	const pinned: typeof actionables = [];
	const seen = new Set<string>();
	for (const ref of blockingRefs) {
		const item = byRef.get(ref);
		if (item && !seen.has(ref)) {
			pinned.push(item);
			seen.add(ref);
		}
	}
	if (actionRef && byRef.has(actionRef) && !seen.has(actionRef)) {
		pinned.push(byRef.get(actionRef)!);
		seen.add(actionRef);
	}
	for (const item of actionables) {
		if (!seen.has(item.ref)) {
			pinned.push(item);
			seen.add(item.ref);
		}
	}
	return pinned;
}

export function projectAgentView(input: AgentViewProjectionInput): {
	view: AgentViewV1;
	candidateBindings: Array<{ alias: string; resourceRef: string; role: string; label?: string; actions: AgentCandidateAction[] }>;
} {
	const detail = input.detail ?? "decision";
	const maxCandidates = detail === "expanded" ? AGENT_CONTEXT_BOUNDS.l1MaxCandidates : AGENT_CONTEXT_BOUNDS.l0MaxCandidates;
	const maxChars = input.maxChars
		?? (detail === "expanded" ? AGENT_CONTEXT_BOUNDS.l1MaxChars : AGENT_CONTEXT_BOUNDS.l0MaxChars);

	const actionables = input.observation.actionables ?? [];
	const ordered = pinOrder(actionables, input.blockingRefs ?? [], input.actionRef);
	const limited = ordered.slice(0, maxCandidates);

	const candidateBindings: Array<{ alias: string; resourceRef: string; role: string; label?: string; actions: AgentCandidateAction[] }> = [];
	const candidates: AgentCandidate[] = [];
	for (let i = 0; i < limited.length; i++) {
		const alias = `a_${String(i + 1).padStart(2, "0")}`;
		const projected = projectActionableToCandidate(limited[i]!, alias);
		if (input.focus?.roles?.length && !input.focus.roles.some((r) => projected.role.includes(r))) {
			// focus filters ordering only after pins; skip non-matching non-pinned if over budget later
		}
		candidates.push(projected);
		candidateBindings.push({
			alias,
			resourceRef: limited[i]!.ref,
			role: projected.role,
			label: projected.label,
			actions: projected.actions,
		});
	}

	const notices = buildNotices(input.observation);
	const reads = (input.reads ?? []).slice(0, detail === "expanded" ? 16 : AGENT_CONTEXT_BOUNDS.l0MaxReads);
	const summary = buildSummary(input.observation, candidates, notices);

	const reanchor = pageReanchorReason(
		input.context.pageIdentity,
		identityFromObservation(input.observation),
	);

	const contextSummary: BrowserAgentContextSummary = {
		contextRef: input.context.id,
		contextRevision: input.context.revision,
		state: input.context.state,
		pageChanged: Boolean(reanchor || input.observation.reanchorReason),
		...(reanchor || input.observation.reanchorReason
			? { reanchorReason: (reanchor ?? input.observation.reanchorReason)! }
			: {}),
	};

	const changes: AgentChangeSummary | undefined = input.observation.diff
		? { kind: input.observation.reanchorReason ? "document" : "same_document", summary: "observation diff present" }
		: { kind: "none" };

	const decision = decideAfterView({
		candidates,
		reads,
		blockedReason: input.context.state === "ambiguous" ? "TARGET_AMBIGUOUS" : undefined,
	});

	let view: AgentViewV1 = {
		schema: AGENT_VIEW_SCHEMA,
		context: contextSummary,
		page: {
			...(input.pageTitle ? { title: input.pageTitle } : {}),
			...(input.observation.target.url ? { url: input.observation.target.url } : {}),
			changed: contextSummary.pageChanged,
		},
		summary,
		notices,
		candidates,
		...(input.targets ? { targets: input.targets } : {}),
		changes,
		...(reads.length ? { reads } : {}),
		decision,
		limits: {
			cost: { chars: 0, bytes: 0, estimatedTokens: 0 },
		},
		trace: input.trace ?? { available: false, unavailableReason: "trace_not_recorded" },
	};

	let cost = jsonCost(view);
	let truncated = false;
	while (cost.chars > maxChars && view.candidates.length > 1) {
		view = {
			...view,
			candidates: view.candidates.slice(0, Math.max(1, view.candidates.length - 1)),
			summary: `${summary} (truncated)`,
		};
		cost = jsonCost(view);
		truncated = true;
	}
	view = {
		...view,
		limits: {
			cost,
			...(truncated ? { truncated: true } : {}),
		},
	};

	return { view, candidateBindings };
}

export function identityFromObservation(observation: PageObservationV3): PageIdentity | undefined {
	const t = observation.target;
	const s = observation.snapshot;
	const browserSessionId = t.browserSessionId ?? s.browserSessionId;
	const tabId = t.tabId ?? s.tabId;
	const targetGeneration = t.targetGeneration ?? s.targetGeneration;
	const pageEpoch = t.pageEpoch ?? s.pageEpoch;
	const url = t.url ?? s.url ?? "";
	if (!browserSessionId || !tabId || !targetGeneration || !pageEpoch) return undefined;
	return {
		browserSessionId,
		tabId,
		targetGeneration,
		pageEpoch,
		url,
		...(s.documentId ? { documentId: s.documentId } : {}),
	};
}

/** Critical actionable recall helper for golden labels. */
export function l0ContainsRequiredActionables(
	candidates: AgentCandidate[],
	bindings: Array<{ alias: string; resourceRef: string }>,
	requiredResourceRefs: string[],
): { ok: boolean; missing: string[] } {
	const present = new Set(bindings.map((b) => b.resourceRef));
	const missing = requiredResourceRefs.filter((ref) => !present.has(ref));
	// also require aliases returned
	const aliases = new Set(candidates.map((c) => c.ref));
	for (const b of bindings) {
		if (requiredResourceRefs.includes(b.resourceRef) && !aliases.has(b.alias)) {
			if (!missing.includes(b.resourceRef)) missing.push(b.resourceRef);
		}
	}
	return { ok: missing.length === 0, missing };
}
