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
		if (enabled) {
			// Native select advertises select; custom combobox stays activate/press only via role=combobox without select kind.
			if (kind === "select" || kind === "listbox") actions.push("select", "activate", "press");
			else actions.push("activate", "press");
		}
	}
	if (["scrollbar", "region", "document", "main", "list"].includes(kind) || kind === "generic") {
		actions.push("scroll");
	}
	if (kind === "form") {
		if (enabled) actions.push("submit");
	}
	if (kind === "button" && enabled) {
		// submit may target a submit button
		actions.push("submit");
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
	| "semantic.select"
	| "semantic.drag"
	| "semantic.submit"
	| "semantic.navigate"
	| "semantic.history";

export const SEMANTIC_COMPLETION_RESOLVER_IDS: Record<AgentPublishedWriteKind, SemanticCompletionResolverId> = {
	activate: "semantic.activate",
	fill: "semantic.fill",
	press: "semantic.press",
	scroll: "semantic.scroll",
	select: "semantic.select",
	drag: "semantic.drag",
	submit: "semantic.submit",
	navigate: "semantic.navigate",
	history: "semantic.history",
};

export function resolverIdForKind(kind: AgentPublishedWriteKind): SemanticCompletionResolverId {
	return SEMANTIC_COMPLETION_RESOLVER_IDS[kind];
}
