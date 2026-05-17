import { asArray, isRecord, type Summary } from "./common";

function compactNode(raw: unknown): Record<string, unknown> | undefined {
	if (!isRecord(raw)) return undefined;
	return {
		nodeId: raw.nodeId,
		selector: raw.selector,
		tag: raw.tag,
		role: raw.role,
		text: raw.text,
		ariaLabel: raw.ariaLabel,
		clickable: raw.clickable,
		editable: raw.editable,
		disabled: raw.disabled,
		bbox: raw.bbox,
		framePath: asArray(raw.framePath).slice(0, 4),
	};
}

export function summarizeSemanticDomSnapshotData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const nodes = asArray(data.nodes).map(compactNode).filter(Boolean).slice(0, 40);
	const clickable = nodes.filter((node) => node?.clickable === true).length;
	const editable = nodes.filter((node) => node?.editable === true).length;
	return {
		snapshotId: data.snapshotId,
		url: data.url,
		title: data.title,
		viewport: data.viewport,
		nodeCount: data.nodeCount ?? asArray(data.nodes).length,
		returnedNodes: nodes.length,
		clickable,
		editable,
		truncated: data.truncated,
		frames: asArray(data.frames).slice(0, 8),
		nodes,
	};
}

export function summarizeSemanticDomActionData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	return {
		action: data.action,
		clicked: data.clicked,
		typed: data.typed,
		submitted: data.submitted,
		valueLength: data.valueLength,
		finalValuePreview: data.finalValuePreview,
		url: data.url,
		title: data.title,
		target: compactNode(data.target),
	};
}
