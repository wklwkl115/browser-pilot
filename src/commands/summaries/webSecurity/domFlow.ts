import { artifactHints, asArray, increment, isRecord, summaryTable, textPreview, topCounts, type Summary } from "../common.js";

function summarizeListenerCollection(data: Record<string, unknown>): Summary {
	const listeners = asArray(data.listeners);
	const typeCounts: Record<string, number> = {};
	for (const item of listeners) increment(typeCounts, isRecord(item) ? item.type : undefined);
	return {
		selector: data.selector,
		node: isRecord(data.node) ? data.node : undefined,
		count: Number(data.count || listeners.length || 0),
		truncated: data.truncated === true,
		eventTypeCounts: topCounts(typeCounts),
		listeners: summaryTable(listeners, [
			{ key: "type", value: (item) => isRecord(item) ? item.type : undefined },
			{ key: "capture", value: (item) => isRecord(item) ? item.useCapture : undefined },
			{ key: "passive", value: (item) => isRecord(item) ? item.passive : undefined },
			{ key: "once", value: (item) => isRecord(item) ? item.once : undefined },
			{ key: "url", value: (item) => isRecord(item) && isRecord(item.handler) ? item.handler.url : undefined },
			{ key: "line", value: (item) => isRecord(item) && isRecord(item.handler) ? item.handler.line : undefined },
			{ key: "column", value: (item) => isRecord(item) && isRecord(item.handler) ? item.handler.column : undefined },
			{ key: "handler", value: (item) => isRecord(item) && isRecord(item.handler) && typeof item.handler.functionName === "string" ? textPreview(item.handler.functionName, 80) : undefined },
		], 12),
	};
}

function summarizeSinkHints(data: Record<string, unknown>): Summary {
	const hints = asArray(data.hints);
	const sinks = asArray(data.sinks);
	const kindCounts: Record<string, number> = {};
	for (const item of hints) increment(kindCounts, isRecord(item) ? item.kind : undefined);
	return {
		selector: data.selector,
		node: isRecord(data.node) ? data.node : undefined,
		count: Number(data.count || hints.length || 0),
		hintKindCounts: topCounts(kindCounts),
		hints: summaryTable(hints, [
			{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
			{ key: "eventType", value: (item) => isRecord(item) ? item.eventType : undefined },
			{ key: "suspicious", value: (item) => isRecord(item) ? item.suspicious : undefined },
			{ key: "detail", value: (item) => isRecord(item) && typeof item.detail === "string" ? textPreview(item.detail, 120) : undefined },
		], 12),
		sinks: summaryTable(sinks, [
			{ key: "selector", value: (item) => isRecord(item) ? item.selector : undefined },
			{ key: "innerHTML", value: (item) => isRecord(item) && typeof item.innerHTML === "string" ? textPreview(item.innerHTML, 120) : undefined },
			{ key: "text", value: (item) => isRecord(item) && typeof item.text === "string" ? textPreview(item.text, 120) : undefined },
		], 8),
	};
}

function summarizeListenerChain(data: Record<string, unknown>): Summary {
	const chain = asArray(data.chain);
	const typeCounts: Record<string, number> = {};
	for (const item of chain) increment(typeCounts, isRecord(item) ? item.eventType : undefined);
	return {
		selector: data.selector,
		node: isRecord(data.node) ? data.node : undefined,
		count: Number(data.count || chain.length || 0),
		eventTypeCounts: topCounts(typeCounts),
		chain: summaryTable(chain, [
			{ key: "index", value: (item) => isRecord(item) ? item.index : undefined },
			{ key: "eventType", value: (item) => isRecord(item) ? item.eventType : undefined },
			{ key: "capture", value: (item) => isRecord(item) && isRecord(item.flags) ? item.flags.capture : undefined },
			{ key: "passive", value: (item) => isRecord(item) && isRecord(item.flags) ? item.flags.passive : undefined },
			{ key: "once", value: (item) => isRecord(item) && isRecord(item.flags) ? item.flags.once : undefined },
			{ key: "url", value: (item) => isRecord(item) && isRecord(item.handler) ? item.handler.url : undefined },
			{ key: "line", value: (item) => isRecord(item) && isRecord(item.handler) ? item.handler.line : undefined },
			{ key: "handler", value: (item) => isRecord(item) && isRecord(item.handler) && typeof item.handler.functionName === "string" ? textPreview(item.handler.functionName, 80) : undefined },
		], 12),
	};
}

export function summarizeDomFlowData(command: string, value: unknown): Summary {
	// Real saved artifacts are flat, but honor a defensive `data` wrapper if present
	// so the Layer-1 jsonPath always addresses the raw artifact correctly.
	const wrapped = isRecord(value) && isRecord(value.data);
	const root = wrapped ? (value as Record<string, unknown>).data as Record<string, unknown> : isRecord(value) ? value : {};
	const prefix = wrapped ? "data." : "";
	if (command === "hook.getListenerChain") {
		const summary = summarizeListenerChain(root);
		return { ...summary, ...(asArray(root.chain).length ? artifactHints([{ label: "full listener chain", jsonPath: `${prefix}chain`, kind: "summary-section", count: asArray(root.chain).length }]) : {}) };
	}
	if (command === "hook.getSinkHints") {
		const summary = summarizeSinkHints(root);
		const reads = [];
		if (asArray(root.hints).length) reads.push({ label: "all sink hints", jsonPath: `${prefix}hints`, kind: "summary-section", count: asArray(root.hints).length });
		if (asArray(root.sinks).length) reads.push({ label: "all sinks", jsonPath: `${prefix}sinks`, kind: "summary-section", count: asArray(root.sinks).length });
		return { ...summary, ...artifactHints(reads) };
	}
	const summary = summarizeListenerCollection(root);
	return { ...summary, ...(asArray(root.listeners).length ? artifactHints([{ label: "all node listeners", jsonPath: `${prefix}listeners`, kind: "summary-section", count: asArray(root.listeners).length }]) : {}) };
}
