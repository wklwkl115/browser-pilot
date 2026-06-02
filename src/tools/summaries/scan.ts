import { asArray, isRecord, summaryTable, textPreview, type Summary } from "./common.js";
import { buildDomEntityFromScanActionable, buildRegionEntityFromListHint, buildVisionRegionFromCanvasActionable, dedupeEntities, withRegisteredRef, type Entity, type ScanEntityContext } from "../../abml/entity.js";
import { registerRefDescriptor } from "../../resources/resourceStore.js";

export type ScanSummaryOptions = {
	detailLevel?: unknown;
	maxChars?: number;
	entityContext?: Partial<ScanEntityContext>;
};

type Limits = {
	primaryActions: number;
	actionRows: number;
	lists: number;
	listRows: number;
	textSignals: number;
	headings: number;
	interactive: number;
	textPreviewChars: number;
};

type RankedAction = {
	node: Record<string, unknown>;
	position: number;
	score: number;
	key: string;
};

const ACTION_INTENT_RE = /\b(sign\s*in|log\s*in|login|submit|continue|next|save|search|checkout|buy|pay|send|create|upload|download|apply|confirm|activate)\b/i;
const LOW_VALUE_ACTION_RE = /\b(cancel|close|dismiss|back|learn\s*more|privacy|terms)\b/i;
const TEXT_SIGNAL_RE = /\b(error|failed|failure|invalid|required|success|saved|complete|status|loading|empty|warning|checkout|login|sign\s*in|search|upload|download|price|total|cart|modal|dialog)\b/i;
const SENSITIVE_LINE_RE = /\b(value=|password|token|cookie|authorization|bearer|secret|api[_-]?key|session=)\b/i;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function stableLength(value: unknown): number {
	return JSON.stringify(value).length;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asFiniteNumber(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function cleanInlineText(value: unknown, maxChars = 160): string {
	const text = asText(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function normalizeText(value: unknown): string {
	return cleanInlineText(value, 240).toLowerCase().replace(/[\d$€£¥.,:;!?()[\]{}]+/g, " ").replace(/\s+/g, " ").trim();
}

function selectorTail(value: unknown): string | undefined {
	const selector = asText(value).trim();
	if (!selector) return undefined;
	if (selector.length <= 90 || /^#[A-Za-z0-9_-]+$/.test(selector)) return selector;
	const parts = selector.split(/\s*>\s*/).filter(Boolean);
	return `… > ${parts.slice(-3).join(" > ")}`;
}

function pointTuple(value: unknown): [number, number] | undefined {
	if (!isRecord(value)) return undefined;
	const x = asFiniteNumber(value.x);
	const y = asFiniteNumber(value.y);
	return x === undefined || y === undefined ? undefined : [Math.round(x), Math.round(y)];
}

function actionKind(node: Record<string, unknown>): string {
	const tag = asText(node.tag).toLowerCase();
	const role = asText(node.role).toLowerCase();
	if (node.editable === true) {
		if (tag === "select") return "select";
		if (tag === "textarea") return "textarea";
		return "input";
	}
	if (tag === "a" || role === "link") return "link";
	if (tag === "select" || role === "option") return "select";
	if (role === "checkbox" || role === "switch") return "check";
	if (role === "radio") return "radio";
	if (tag === "button" || role === "button") return "button";
	if (role === "tab") return "tab";
	return tag || role || "other";
}

function actionIntent(node: Record<string, unknown>): string | undefined {
	const text = `${asText(node.action)} ${asText(node.label)} ${asText(node.text)}`;
	const match = text.match(ACTION_INTENT_RE);
	return match ? match[1].replace(/\s+/g, " ").toLowerCase() : undefined;
}

function actionDisplayName(node: Record<string, unknown>): string {
	const editable = node.editable === true;
	const candidates = editable ? [node.action, node.role, node.tag, node.selector] : [node.action, node.label, node.text, node.role, node.tag, node.selector];
	for (const candidate of candidates) {
		const text = cleanInlineText(candidate, 96);
		if (!text) continue;
		return text;
	}
	return editable ? "editable field" : "action";
}

function actionFlags(node: Record<string, unknown>, repeatedCount: number, why?: string): string[] | undefined {
	const flags: string[] = [];
	if (node.editable === true) flags.push("edit");
	if (node.clickable === true && node.editable !== true) flags.push("click");
	if (node.disabled === true) flags.push("disabled");
	if (node.hitOk === false) flags.push("covered");
	if (why && !LOW_VALUE_ACTION_RE.test(why)) flags.push("primary");
	if (repeatedCount > 1) flags.push("repeated");
	return flags.length ? flags : undefined;
}

function compactHitTarget(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const out: Record<string, unknown> = {};
	for (const key of ["tag", "id", "class", "text"] as const) {
		const text = cleanInlineText(value[key], key === "text" ? 80 : 48);
		if (text) out[key] = text;
	}
	return Object.keys(out).length ? out : undefined;
}

function scoreAction(node: Record<string, unknown>): number {
	let score = Number(node.priority || 0) * 0.4;
	const text = `${asText(node.action)} ${asText(node.label)} ${asText(node.text)}`;
	if (node.hitOk === true) score += 120;
	if (node.hitOk === false) score -= 200;
	if (node.disabled === true) score -= 250;
	if (node.editable === true) score += 260;
	if (node.clickable === true) score += 180;
	if (ACTION_INTENT_RE.test(text)) score += 350;
	if (LOW_VALUE_ACTION_RE.test(text)) score -= 80;
	const selector = asText(node.selector);
	if (/^#[A-Za-z0-9_-]+$/.test(selector)) score += 80;
	if (selector.length > 120) score -= 80;
	const rect = isRecord(node.rect) ? node.rect : {};
	const y = asFiniteNumber(rect.y);
	if (y !== undefined && y >= 0 && y < 900) score += 80;
	if (y !== undefined && y > 1800) score -= 120;
	score -= Math.min(100, cleanInlineText(node.label || node.text, 200).length / 4);
	return score;
}

function actionKey(node: Record<string, unknown>): string {
	return [actionKind(node), normalizeText(node.action || node.label || node.text), selectorTail(node.selector)].filter(Boolean).join("|");
}

function compactAction(node: Record<string, unknown>, position: number, repeatedCount: number): Record<string, unknown> {
	const why = actionIntent(node);
	const out: Record<string, unknown> = {
		i: Number(node.index ?? position),
		k: actionKind(node),
		name: actionDisplayName(node),
		jsonPath: `data.actionables[${position}]`,
	};
	const selector = selectorTail(node.selector);
	const point = pointTuple(node.point);
	const flags = actionFlags(node, repeatedCount, why);
	if (selector) out.sel = selector;
	if (point) out.at = point;
	if (typeof node.hitOk === "boolean") out.ok = node.hitOk;
	if (flags) out.flags = flags;
	if (why) out.why = why;
	if (repeatedCount > 1) out.count = repeatedCount;
	if (node.hitOk === false) {
		const hitTarget = compactHitTarget(node.hitTarget);
		if (hitTarget) out.coveredBy = hitTarget;
	}
	return out;
}

function rankedActions(actionables: unknown[]): RankedAction[] {
	return actionables.filter(isRecord).map((node, position) => {
		const key = actionKey(node) || `action:${position}`;
		return { node, position, score: scoreAction(node), key };
	});
}

function selectPrimaryActions(actionables: unknown[], limit: number): Record<string, unknown>[] {
	const ranked = rankedActions(actionables);
	const counts = new Map<string, number>();
	for (const item of ranked) counts.set(item.key, (counts.get(item.key) || 0) + 1);
	const selected: RankedAction[] = [];
	const seen = new Set<string>();
	for (const item of ranked.sort((a, b) => b.score - a.score || a.position - b.position)) {
		if (seen.has(item.key)) continue;
		seen.add(item.key);
		selected.push(item);
		if (selected.length >= limit) break;
	}
	return selected.map((item) => compactAction(item.node, item.position, counts.get(item.key) || 1));
}

function summarizeForms(actionables: unknown[], limit: number): Record<string, unknown>[] {
	const ranked = rankedActions(actionables);
	const fields = ranked
		.filter((item) => item.node.editable === true && item.node.disabled !== true)
		.sort((a, b) => b.score - a.score || a.position - b.position)
		.slice(0, 6)
		.map((item) => {
			const action = compactAction(item.node, item.position, 1);
			return { i: action.i, k: action.k, name: action.name, flags: action.flags, jsonPath: action.jsonPath };
		});
	if (!fields.length) return [];
	const submit = ranked
		.filter((item) => item.node.editable !== true && item.node.disabled !== true)
		.sort((a, b) => b.score - a.score || a.position - b.position)
		.map((item) => compactAction(item.node, item.position, 1))
		.find((item) => item.why || Array.isArray(item.flags) && item.flags.includes("primary"));
	const form: Record<string, unknown> = { name: submit?.name || fields[0]?.name || "form", fields };
	if (submit) form.submit = { i: submit.i, name: submit.name, jsonPath: submit.jsonPath };
	return [form].slice(0, limit);
}

function summarizeLists(listHints: unknown[], limit: number): Record<string, unknown>[] {
	return listHints.filter(isRecord).slice(0, limit).map((item, index) => {
		const hidden = Number(item.hiddenCount || 0);
		const sampleHidden = asArray(item.sampleHidden).map((entry) => cleanInlineText(entry, 90)).filter(Boolean).slice(0, 2);
		const out: Record<string, unknown> = {
			i: index,
			sel: selectorTail(item.selector) || "",
			n: Number(item.itemCount || 0),
			sample: cleanInlineText(item.firstItemPreview, 120),
			jsonPath: `data.list_hints[${index}]`,
		};
		if (hidden > 0) out.compressed = hidden;
		if (sampleHidden.length) out.more = sampleHidden;
		return out;
	});
}

function lineText(line: string): string {
	return cleanInlineText(line.replace(/^<h([1-6])\b[^>]*>/i, "H$1 "), 180);
}

function headingSignals(lines: string[], limit: number): string[] {
	return lines
		.filter((line) => /^<h[1-6]\b/i.test(line) || /^#{1,6}\s/.test(line))
		.map(lineText)
		.filter(Boolean)
		.slice(0, limit);
}

function scoreTextSignal(text: string): number {
	let score = 0;
	if (TEXT_SIGNAL_RE.test(text)) score += 100;
	if (/\b\d+\s*(items?|results?|messages?|errors?)\b/i.test(text)) score += 40;
	if (/[$€£¥]\s*\d|\b\d+(\.\d{2})?\s*(usd|eur|gbp|cny)\b/i.test(text)) score += 35;
	if (text.length >= 24 && text.length <= 140) score += 25;
	if (text.length > 180) score -= 60;
	return score;
}

function textSignals(lines: string[], actionNames: Set<string>, limit: number): string[] {
	const seen = new Set<string>();
	const ranked: Array<{ index: number; score: number; text: string }> = [];
	for (const [index, line] of lines.entries()) {
		if (SENSITIVE_LINE_RE.test(line)) continue;
		const text = lineText(line);
		if (text.length < 12) continue;
		const normalized = normalizeText(text);
		if (!normalized || seen.has(normalized)) continue;
		if (actionNames.has(normalized)) continue;
		const score = scoreTextSignal(text);
		if (score <= 0) continue;
		seen.add(normalized);
		ranked.push({ index, score, text: cleanInlineText(text, 140) });
	}
	return ranked.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).sort((a, b) => a.index - b.index).map((item) => item.text);
}

function scanBudget(options: ScanSummaryOptions): number {
	const maxChars = Number(options.maxChars || 0);
	const level = String(options.detailLevel || "summary").toLowerCase();
	const ratio = level === "preview" ? 0.35 : 0.25;
	const fallback = level === "preview" ? 5_200 : 4_200;
	return maxChars > 0 ? clamp(Math.floor(maxChars * ratio), 2_200, level === "preview" ? 8_000 : 5_600) : fallback;
}

function limitSets(options: ScanSummaryOptions): Limits[] {
	const preview = String(options.detailLevel || "summary").toLowerCase() === "preview";
	return preview ? [
		{ primaryActions: 12, actionRows: 8, lists: 5, listRows: 5, textSignals: 8, headings: 8, interactive: 10, textPreviewChars: 520 },
		{ primaryActions: 10, actionRows: 6, lists: 4, listRows: 4, textSignals: 6, headings: 6, interactive: 6, textPreviewChars: 360 },
		{ primaryActions: 6, actionRows: 4, lists: 3, listRows: 3, textSignals: 4, headings: 4, interactive: 3, textPreviewChars: 180 },
	] : [
		{ primaryActions: 10, actionRows: 6, lists: 4, listRows: 4, textSignals: 6, headings: 6, interactive: 6, textPreviewChars: 360 },
		{ primaryActions: 8, actionRows: 5, lists: 3, listRows: 3, textSignals: 5, headings: 4, interactive: 4, textPreviewChars: 240 },
		{ primaryActions: 5, actionRows: 3, lists: 2, listRows: 2, textSignals: 3, headings: 3, interactive: 2, textPreviewChars: 120 },
		{ primaryActions: 3, actionRows: 0, lists: 2, listRows: 0, textSignals: 2, headings: 0, interactive: 0, textPreviewChars: 0 },
	];
}

function scanEntityContext(item: Record<string, unknown>, options: ScanSummaryOptions): ScanEntityContext {
	const context = options.entityContext || {};
	const url = context.url ?? stringField(item.url);
	return {
		browserSessionId: context.browserSessionId ?? stringField(item.browserSessionId),
		tabId: context.tabId ?? numberField(item.tabId),
		url,
		observationId: context.observationId ?? stringField(item.observationId) ?? `scan:${url || "unknown"}`,
		capturedAt: context.capturedAt ?? numberField(item.capturedAt) ?? Date.now(),
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function buildScanEntities(item: Record<string, unknown>, options: ScanSummaryOptions): { entities: Entity[]; primaryEntities: Entity[]; listEntities: Entity[]; visualRegions: Entity[] } {
	const context = scanEntityContext(item, options);
	const actionables = asArray(item.actionables).filter(isRecord);
	const listHints = asArray(item.list_hints).filter(isRecord);
	const canvasRegions = asArray(item.canvas_regions).filter(isRecord);
	const actionEntities = dedupeEntities(actionables.map((node) => {
		const built = buildDomEntityFromScanActionable(node, context);
		const refId = registerRefDescriptor({ descriptor: built.descriptor, resourceKind: "scan", name: built.entity.name || built.entity.role });
		return withRegisteredRef(built.entity, refId);
	}));
	const visualRegions = dedupeEntities((canvasRegions.length ? canvasRegions : actionables.filter((node) => String(node.tag || "").toLowerCase() === "canvas"))
		.map((node) => {
			const built = buildVisionRegionFromCanvasActionable(node, context);
			const refId = registerRefDescriptor({ descriptor: built.descriptor, resourceKind: "scan", name: built.entity.name || built.entity.role });
			return withRegisteredRef(built.entity, refId);
		}));
	const listEntities = dedupeEntities(listHints.map((node, index) => {
		const built = buildRegionEntityFromListHint(node, context, index);
		const refId = registerRefDescriptor({ descriptor: built.descriptor, resourceKind: "scan", name: built.entity.name || `list-${index}` });
		return withRegisteredRef(built.entity, refId);
	}));
	const entities = dedupeEntities([...actionEntities, ...listEntities, ...visualRegions]);
	const primaryEntities = actionEntities.filter((entity) => entity.hints?.jsonPath && String(entity.hints.jsonPath).startsWith("data.actionables[")).slice(0, 10);
	return { entities, primaryEntities, listEntities, visualRegions };
}

function buildSummary(item: Record<string, unknown>, tabs: unknown[], limits: Limits, options: ScanSummaryOptions, omitted: string[] = []): Summary {
	const content = typeof item.content === "string" ? item.content : "";
	const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const actionables = asArray(item.actionables).filter(isRecord);
	const listHints = asArray(item.list_hints).filter(isRecord);
	const primaryActions = selectPrimaryActions(actionables, limits.primaryActions);
	const actionNames = new Set(primaryActions.map((action) => normalizeText(action.name)).filter(Boolean));
	const headings = headingSignals(lines, limits.headings);
	const scanEntities = buildScanEntities(item, options);
	const actionEntityByPath = new Map(scanEntities.entities.map((entity) => [String(entity.hints?.jsonPath || ""), entity]));
	const primaryActionsWithEntities = primaryActions.map((action) => ({ ...action, ...(actionEntityByPath.get(String(action.jsonPath || "")) ? { entity: actionEntityByPath.get(String(action.jsonPath || "")) } : {}) }));
	const focus: Record<string, unknown> = {
		top_layer: item.top_layer,
		primary_actions: primaryActionsWithEntities,
		forms: summarizeForms(actionables, 2),
		lists: summarizeLists(listHints, limits.lists),
		headings,
		text_signals: textSignals(lines, actionNames, limits.textSignals),
		primary_entities: scanEntities.primaryEntities,
		list_entities: scanEntities.listEntities.slice(0, limits.lists),
		visual_regions: scanEntities.visualRegions.slice(0, 4),
	};
	return {
		summaryVersion: 2,
		url: item.url,
		title: item.title,
		readyState: item.readyState,
		text_only: item.text_only,
		contentChars: content.length,
		lineCount: lines.length,
		truncated: item.truncated,
		node_count: item.node_count,
		iframe_notes: item.iframe_notes,
		top_layer: item.top_layer,
		tabs_count: tabs.length,
		page: {
			contentChars: content.length,
			lineCount: lines.length,
			node_count: item.node_count,
			truncated: item.truncated,
			tabs_count: tabs.length,
		},
		focus,
		artifact_hints: {
			jsonPaths: {
				content: "data.content",
				actionables: "data.actionables",
				list_hints: "data.list_hints",
			},
			preferredReads: [
				{ label: "all actionables with full selectors", jsonPath: "data.actionables" },
				{ label: "full simplified DOM/text", jsonPath: "data.content" },
				{ label: "repeated list hints", jsonPath: "data.list_hints" },
			],
		},
		list_hints: summaryTable(listHints, [
			{ key: "selector", value: (node) => node.selector },
			{ key: "itemCount", value: (node) => node.itemCount },
			{ key: "hiddenCount", value: (node) => node.hiddenCount },
			{ key: "firstItemPreview", value: (node) => node.firstItemPreview },
		], limits.listRows),
		actionables: summaryTable(actionables, [
			{ key: "index", value: (node) => node.index },
			{ key: "tag", value: (node) => node.tag },
			{ key: "role", value: (node) => node.role },
			{ key: "action", value: (node) => node.action || "" },
			{ key: "label", value: (node) => node.label || node.text },
			{ key: "selector", value: (node) => node.selector },
			{ key: "point", value: (node) => node.point },
			{ key: "hitOk", value: (node) => node.hitOk },
		], limits.actionRows),
		interactive: lines.filter((line) => /^<(a|button|input|textarea|select|option)\b/i.test(line)).slice(0, limits.interactive),
		headings,
		textPreview: limits.textPreviewChars > 0 ? textPreview(content, limits.textPreviewChars) : "",
		...(omitted.length ? { summaryOmitted: omitted } : {}),
	};
}

export function summarizeScanData(data: unknown, tabs: unknown[] = [], options: ScanSummaryOptions = {}): Summary {
	const item = isRecord(data) ? data : {};
	const budget = scanBudget(options);
	const sets = limitSets(options);
	for (const [index, limits] of sets.entries()) {
		const omitted = index === 0 ? [] : ["interactive", "textPreview", "legacyRows"];
		const summary = buildSummary(item, tabs, limits, options, omitted);
		if (stableLength(summary) <= budget || index === sets.length - 1) return summary;
	}
	return buildSummary(item, tabs, sets[sets.length - 1], options, ["interactive", "textPreview", "legacyRows"]);
}
