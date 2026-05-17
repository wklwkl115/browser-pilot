import { Type } from "typebox";
import { buildSemanticDomActionScript, buildSemanticDomSnapshotScript } from "../dom/buildSemanticDomScript";
import { normalizeError } from "../utils/errors";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { summarizeSemanticDomActionData, summarizeSemanticDomSnapshotData } from "./summaries/index";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

type SemanticDomNodeRecord = Record<string, unknown> & {
	nodeId: string;
	snapshotId: string;
	tabId?: number | string;
	selector: string;
	path: string;
	framePath?: string[];
};

type SemanticDomSnapshotRecord = {
	snapshotId: string;
	tabId?: number | string;
	createdAt: number;
	nodes: Map<string, SemanticDomNodeRecord>;
};

type SemanticDomStore = {
	seq: number;
	snapshots: Map<string, SemanticDomSnapshotRecord>;
	nodes: Map<string, SemanticDomNodeRecord>;
	latestByTab: Map<string, string>;
};

function codedSemanticDomError(code: string, message: string, details: Record<string, unknown> = {}): Error {
	const error = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
	error.name = "SemanticDomError";
	error.code = code;
	error.details = details;
	delete error.stack;
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function snapshotIdFor(store: SemanticDomStore): string {
	store.seq += 1;
	return `dom_${Date.now().toString(36)}_${store.seq.toString(36)}`;
}

function trimStore(store: SemanticDomStore, maxSnapshots = 20): void {
	const ordered = Array.from(store.snapshots.values()).sort((a, b) => a.createdAt - b.createdAt);
	while (ordered.length > maxSnapshots) {
		const old = ordered.shift();
		if (!old) break;
		store.snapshots.delete(old.snapshotId);
		for (const nodeId of old.nodes.keys()) store.nodes.delete(nodeId);
		for (const [tabKey, snapshotId] of Array.from(store.latestByTab.entries())) if (snapshotId === old.snapshotId) store.latestByTab.delete(tabKey);
	}
}

function tabKey(tabId: unknown): string | undefined {
	return tabId === undefined || tabId === null || tabId === "" ? undefined : String(tabId);
}

function storeSnapshot(store: SemanticDomStore, tabId: unknown, rawData: Record<string, unknown>): Record<string, unknown> {
	const snapshotId = snapshotIdFor(store);
	const rawNodes = Array.isArray(rawData.nodes) ? rawData.nodes : [];
	const nodes = rawNodes.filter(isRecord).map((node, index) => {
		const nodeId = `${snapshotId}_n${index + 1}`;
		return {
			...node,
			nodeId,
			snapshotId,
			tabId: tabId as number | string | undefined,
			selector: typeof node.selector === "string" ? node.selector : "",
			path: typeof node.path === "string" ? node.path : "",
			framePath: asStringArray(node.framePath),
		} satisfies SemanticDomNodeRecord;
	});
	const snapshot: SemanticDomSnapshotRecord = { snapshotId, tabId: tabId as number | string | undefined, createdAt: Date.now(), nodes: new Map(nodes.map((node) => [node.nodeId, node])) };
	store.snapshots.set(snapshotId, snapshot);
	for (const node of nodes) store.nodes.set(node.nodeId, node);
	const key = tabKey(tabId);
	if (key) store.latestByTab.set(key, snapshotId);
	trimStore(store);
	return { ...rawData, snapshotId, nodeCount: nodes.length, nodes };
}

function assertNodeMatchesRequestedTab(node: SemanticDomNodeRecord, requestedTabId?: unknown): SemanticDomNodeRecord {
	const requested = tabKey(requestedTabId);
	const actual = tabKey(node.tabId);
	if (requested && actual && requested !== actual) {
		throw codedSemanticDomError("DOM_NODE_TAB_MISMATCH", "Semantic DOM nodeId belongs to a different tab; refresh browser_dom_snapshot for the target tab", { nodeId: node.nodeId, snapshotId: node.snapshotId, requestedTabId, tabId: node.tabId });
	}
	return node;
}

function findNode(store: SemanticDomStore, nodeId: unknown, snapshotId?: unknown, requestedTabId?: unknown): SemanticDomNodeRecord {
	const id = String(nodeId || "").trim();
	if (!id) throw codedSemanticDomError("DOM_NODE_ID_REQUIRED", "browser_dom action requires nodeId", {});
	if (snapshotId) {
		const snapshot = store.snapshots.get(String(snapshotId));
		const node = snapshot?.nodes.get(id);
		if (node) return assertNodeMatchesRequestedTab(node, requestedTabId);
		throw codedSemanticDomError("DOM_NODE_NOT_FOUND", "Semantic DOM nodeId was not found in the requested snapshot; refresh browser_dom_snapshot", { nodeId: id, snapshotId });
	}
	const direct = store.nodes.get(id);
	if (direct) return assertNodeMatchesRequestedTab(direct, requestedTabId);
	const latest = tabKey(requestedTabId) ? store.snapshots.get(store.latestByTab.get(String(requestedTabId)) || "") : undefined;
	const latestNode = latest?.nodes.get(id);
	if (latestNode) return assertNodeMatchesRequestedTab(latestNode, requestedTabId);
	throw codedSemanticDomError("DOM_NODE_NOT_FOUND", "Semantic DOM nodeId is expired or unknown; call browser_dom_snapshot again", { nodeId: id });
}

function unwrapSemanticDomRuntimeError(error: unknown): unknown {
	const normalized = normalizeError(error);
	const nested = normalized.details.error;
	if (!isRecord(nested)) return error;
	const code = typeof nested.code === "string" ? nested.code : "";
	if (!code.startsWith("DOM_NODE_")) return error;
	return codedSemanticDomError(code, typeof nested.message === "string" && nested.message ? nested.message : normalized.message, isRecord(nested.details) ? nested.details : {});
}

function sharedParams() {
	return {
		tabId: optionalTargetTabId(),
		detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
		outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
		timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
		maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
	};
}

export function registerSemanticDomTools(context: ToolRegistrarContext) {
	const { pi, ensureStarted } = context;
	const store: SemanticDomStore = { seq: 0, snapshots: new Map(), nodes: new Map(), latestByTab: new Map() };

	pi.registerTool({
		name: "browser_dom_snapshot",
		label: "Browser DOM Snapshot",
		description: "Capture visible semantic DOM nodes in the current viewport and assign short-lived nodeIds for node-based actions.",
		promptSnippet: "Return visible semantic/clickable/editable DOM nodes with nodeId, selector, role, text, and bounding boxes.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_dom_snapshot before browser_dom_click/browser_dom_type when selectors are ambiguous; nodeIds are short-lived and require a fresh snapshot after DOM changes."],
		parameters: Type.Object({
			...sharedParams(),
			maxNodes: Type.Optional(Type.Number({ description: "Maximum visible semantic nodes returned; default 80, max 300." })),
			includeIframes: Type.Optional(Type.Boolean({ description: "Include same-origin iframe semantic nodes; default true." })),
			textLimit: Type.Optional(Type.Number({ description: "Maximum text characters per node; default 240." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_dom_snapshot"));
				const result = await server.executeJavaScript(buildSemanticDomSnapshotScript({ maxNodes: params.maxNodes, includeIframes: params.includeIframes, textLimit: params.textLimit }), { tabId: params.tabId, timeoutMs });
				const data = storeSnapshot(store, result.tabId ?? params.tabId, isRecord(result.data) ? result.data : {});
				return await distilledJsonResult(data, {
					toolName: "browser_dom_snapshot",
					command: "dom.snapshot",
					detailLevel: params.detailLevel,
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `dom-snapshot-${Date.now()}.json`,
					details: { snapshotId: data.snapshotId, tabId: result.tabId ?? params.tabId },
					distill: summarizeSemanticDomSnapshotData,
				});
			} catch (error) {
				return errorResult(unwrapSemanticDomRuntimeError(error));
			}
		},
	});

	function registerDomActionTool(config: { name: "browser_dom_click" | "browser_dom_type"; action: "click" | "type" }) {
		const { name, action } = config;
		pi.registerTool({
			name,
			label: action === "click" ? "Browser DOM Click" : "Browser DOM Type",
			description: action === "click" ? "Click a short-lived semantic DOM nodeId from browser_dom_snapshot without using screen coordinates." : "Type into a short-lived semantic DOM nodeId from browser_dom_snapshot without using screen coordinates.",
			promptSnippet: action === "click" ? "Click a nodeId returned by browser_dom_snapshot using its stored selector/path." : "Type text into a nodeId returned by browser_dom_snapshot using its stored selector/path.",
			promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_dom_snapshot first; if nodeId lookup or DOM resolution fails, refresh the snapshot instead of guessing."],
			parameters: Type.Object({
				...sharedParams(),
				nodeId: Type.String({ description: "Short-lived nodeId returned by browser_dom_snapshot." }),
				snapshotId: Type.Optional(Type.String({ description: "Optional snapshotId returned by browser_dom_snapshot; omitted uses the stored nodeId lookup." })),
				text: action === "type" ? Type.String({ description: "Text to type into the semantic DOM node." }) : Type.Optional(Type.String({ description: "Unused for click." })),
				clear: Type.Optional(Type.Boolean({ description: "Type only: clear existing value before typing; default true." })),
				submit: Type.Optional(Type.Boolean({ description: "Type only: submit enclosing form after typing; default false." })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					const node = findNode(store, params.nodeId, params.snapshotId, params.tabId);
					const server = await ensureStarted();
					const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
					const maxChars = asPositiveInt(params.maxChars, defaultResultBudget(name));
					const result = await server.executeJavaScript(buildSemanticDomActionScript({
						action,
						nodeId: node.nodeId,
						selector: node.selector,
						path: node.path,
						framePath: node.framePath,
						text: typeof params.text === "string" ? params.text : "",
						clear: params.clear,
						submit: params.submit,
					}), { tabId: params.tabId ?? node.tabId, timeoutMs });
					return await distilledJsonResult(result.data, {
						toolName: name,
						command: `dom.${action}`,
						detailLevel: params.detailLevel,
						maxChars,
						ctx,
						outputPath: params.outputPath,
						fallbackName: `dom-${action}-${Date.now()}.json`,
						details: { nodeId: node.nodeId, snapshotId: node.snapshotId, action },
						distill: summarizeSemanticDomActionData,
					});
				} catch (error) {
					return errorResult(unwrapSemanticDomRuntimeError(error));
				}
			},
		});
	}

	registerDomActionTool({ name: "browser_dom_click", action: "click" });
	registerDomActionTool({ name: "browser_dom_type", action: "type" });
}
