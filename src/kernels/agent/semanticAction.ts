import { AGENT_PUBLISHED_WRITE_KINDS, type AgentCandidateAction, type AgentPublishedWriteKind, type SemanticActionV1 } from "./agentTypes.js";

export function isPublishedWriteKind(kind: string): kind is AgentPublishedWriteKind {
	return (AGENT_PUBLISHED_WRITE_KINDS as readonly string[]).includes(kind);
}

export function candidateActionsForRole(role: string, state?: {
	editable?: boolean;
	enabled?: boolean;
	visible?: boolean;
}): AgentCandidateAction[] {
	const actions: AgentCandidateAction[] = [];
	const enabled = state?.enabled !== false;
	const visible = state?.visible !== false;
	if (!visible) return actions;
	const kind = role.toLowerCase();
	if (["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"].includes(kind) && enabled) {
		actions.push("activate");
	}
	if (["textbox", "searchbox", "combobox", "spinbutton"].includes(kind) || state?.editable) {
		if (enabled) {
			actions.push("fill");
			actions.push("press");
		}
	}
	if (kind === "listbox" || kind === "select" || kind === "combobox") {
		// v1 generic select only for native select evidence; still advertise activate/press.
		if (enabled) actions.push("activate", "press");
	}
	if (["scrollbar", "region", "document", "main", "list"].includes(kind) || kind === "generic") {
		actions.push("scroll");
	}
	if (kind === "form" || kind === "button") {
		if (enabled && kind === "form") actions.push("submit");
	}
	// de-dupe preserving order
	return [...new Set(actions)];
}

export function actionAllowedForCandidate(
	action: SemanticActionV1,
	allowed: readonly AgentCandidateAction[],
): boolean {
	if (action.kind === "navigate" || action.kind === "history") return true;
	if (action.kind === "press" && !("ref" in action && action.ref)) return true;
	if (action.kind === "scroll" && !("ref" in action && action.ref)) return true;
	const need = action.kind as AgentCandidateAction;
	return allowed.includes(need);
}

export type SemanticCompletionResolverId =
	| "semantic.activate"
	| "semantic.fill"
	| "semantic.press"
	| "semantic.scroll"
	| "semantic.navigate"
	| "semantic.history";

export const SEMANTIC_COMPLETION_RESOLVER_IDS: Record<AgentPublishedWriteKind, SemanticCompletionResolverId> = {
	activate: "semantic.activate",
	fill: "semantic.fill",
	press: "semantic.press",
	scroll: "semantic.scroll",
	navigate: "semantic.navigate",
	history: "semantic.history",
};

export function resolverIdForKind(kind: AgentPublishedWriteKind): SemanticCompletionResolverId {
	return SEMANTIC_COMPLETION_RESOLVER_IDS[kind];
}
