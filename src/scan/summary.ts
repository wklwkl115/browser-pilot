import { truncateText } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import { buildControlsSourceEntity, buildDomEntityFromScanActionable, buildReferencedTargetEntity, buildRegionEntityFromListHint, buildVisionRegionFromCanvasActionable, dedupeEntities, withRegisteredRef, type Entity, type ScanEntityContext } from "../kernels/abml/entity.js";
import { sanitizeSemanticText } from "../kernels/abml/semanticText.js";
import { summaryRefIdForDescriptor } from "../kernels/refs/refId.js";
import type { PageWorldScanBundleV1, ScanActionable, ScanCanvasRegion, ScanListHint, ScanMediaCandidate, ScanRow } from "../kernels/abml/pageWorldScan.js";

export type Summary = Record<string, unknown>;
type SummaryColumn<T> = { key: string; value: (item: T) => unknown };
type SummaryTable = { columns: string[]; rows: unknown[][]; count: number; truncated?: number };

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function textPreview(text: string, maxChars: number): string {
	return truncateText(text.replace(/\s+/g, " ").trim(), maxChars).text;
}

function summaryTable<T>(items: T[], columns: SummaryColumn<T>[], limit = 20): SummaryTable {
	const rows = items.slice(0, limit).map((item) => columns.map((column) => column.value(item)));
	const table: SummaryTable = { columns: columns.map((column) => column.key), rows, count: items.length };
	if (items.length > rows.length) table.truncated = items.length - rows.length;
	return table;
}

export type ScanSummaryOptions = {
	detailLevel?: unknown;
	maxChars?: number;
	entityContext?: Partial<ScanEntityContext>;
	scanEntities?: ReturnType<typeof buildScanEntities>;
	relevance?: {
		scoreFields: (fields: Record<string, unknown>) => number;
		boosted?: number;
		signals?: string[];
	};
};

type Limits = {
	primaryActions: number;
	actionRows: number;
	lists: number;
	listRows: number;
	mediaRows: number;
	textSignals: number;
	headings: number;
	interactive: number;
	textPreviewChars: number;
};

type RankedAction = {
	node: ScanActionable;
	position: number;
	score: number;
	key: string;
};

type TextSignalCandidate = {
	index: number;
	score: number;
	text: string;
	normalized: string;
};

type PreparedForm = {
	name: string;
	fields: Record<string, unknown>[];
	submit?: Record<string, unknown>;
};

type ScanSummaryPrepared = {
	item: PageWorldScanBundleV1;
	relevance?: ScanSummaryOptions["relevance"];
	tabs: unknown[];
	content: string;
	lines: string[];
	headings: string[];
	interactive: string[];
	actionables: ScanActionable[];
	listHints: ScanListHint[];
	listSummaries: Record<string, unknown>[];
	mediaCandidates: ScanMediaCandidate[];
	visibleRows: ScanRow[];
	rankedActions: RankedAction[];
	sortedRankedActions: RankedAction[];
	actionCounts: Map<string, number>;
	preparedForm?: PreparedForm;
	textSignalCandidates: TextSignalCandidate[];
	scanEntities: ReturnType<typeof buildScanEntities>;
	actionEntityByPath: Map<string, Entity>;
	referencedEntities: Entity[];
};

const FOCUS_REFERENCED_ENTITY_REF_LIMIT = 12;

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

function cleanSemanticText(value: unknown, maxChars = 160): string {
	return sanitizeSemanticText(value, maxChars) || "";
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

function actionKind(node: ScanActionable): string {
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

function actionIntent(node: ScanActionable): string | undefined {
	const text = `${asText(node.action)} ${asText(node.label)} ${asText(node.text)}`;
	const match = text.match(ACTION_INTENT_RE);
	return match ? match[1].replace(/\s+/g, " ").toLowerCase() : undefined;
}

function actionDisplayName(node: ScanActionable): string {
	const editable = node.editable === true;
	const candidates = editable ? [node.displayLabel, node.action, node.role, node.tag] : [node.displayLabel, node.action, node.label, node.text, node.role, node.tag];
	for (const candidate of candidates) {
		const text = cleanSemanticText(candidate, 96);
		if (!text) continue;
		return text;
	}
	return editable ? "editable field" : "action";
}

function actionFlags(node: ScanActionable, repeatedCount: number, why?: string): string[] | undefined {
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

const GRAPHIC_TAGS = new Set(["path", "g", "svg", "use", "polygon", "circle", "rect", "ellipse", "line"]);

function scoreAction(node: ScanActionable): number {
	let score = Number(node.priority || 0) * 0.4;
	const text = `${asText(node.action)} ${asText(node.label)} ${asText(node.text)}`;
	if (node.hitOk === true) score += 120;
	if (node.hitOk === false) score -= 200;
	if (node.disabled === true) score -= 250;
	if (node.edgeUtility === true) score -= 1_080;
	if (node.editable === true) score += 260;
	if (node.clickable === true) score += 180;
	const role = asText(node.role).toLowerCase();
	if (["radio", "checkbox", "switch", "tab", "option", "slider", "spinbutton", "combobox", "listbox"].includes(role)) score += 220; // stateful form controls are high-value focus
	if (typeof node.checked === "boolean") score += 140; // exposes a real checked/selected state
	if (ACTION_INTENT_RE.test(text)) score += 350;
	if (LOW_VALUE_ACTION_RE.test(text)) score -= 80;
	const selector = asText(node.selector);
	if (/^#[A-Za-z0-9_-]+$/.test(selector)) score += 80;
	if (selector.length > 120) score -= 80;
	const rect = node.rect;
	const rectWidth = asFiniteNumber(rect?.width);
	const rectHeight = asFiniteNumber(rect?.height);
	const rectX = asFiniteNumber(rect?.x);
	const rectY = asFiniteNumber(rect?.y);
	const isFixedOrSticky = ["fixed", "sticky"].includes(asText(node.position).toLowerCase());
	const fixedSmallEdge = isFixedOrSticky
		&& rectWidth !== undefined && rectHeight !== undefined && rectWidth <= 180 && rectHeight <= 180
		&& ((rectX !== undefined && rectX <= 32) || (rectY !== undefined && rectY <= 32));
	if (fixedSmallEdge) {
		const tag = asText(node.tag).toLowerCase();
		const isNavLandmark = role === "navigation" || tag === "nav";
		score -= isNavLandmark ? 40 : 80;
	}
	const y = asFiniteNumber(rect?.y);
	if (y !== undefined && y >= 0 && y < 900) score += 80;
	if (y !== undefined && y > 1800) score -= 120;
	score -= Math.min(100, cleanInlineText(node.label || node.text, 200).length / 4);
	if (!asText(node.action) && !asText(node.label) && GRAPHIC_TAGS.has(asText(node.tag).toLowerCase())) score -= 300; // unnamed svg graphic primitives are not real action targets
	return score;
}

function actionKey(node: ScanActionable): string {
	return [actionKind(node), normalizeText(node.action || node.label || node.text), selectorTail(node.selector)].filter(Boolean).join("|");
}

function compactAction(node: ScanActionable, position: number, repeatedCount: number): Record<string, unknown> {
	const why = actionIntent(node);
	const out: Record<string, unknown> = {
		i: Number(node.index ?? position),
		k: actionKind(node),
		name: actionDisplayName(node),
		jsonPath: `data.structure.actionables[${position}]`,
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

function relevanceActionScore(node: ScanActionable, options: ScanSummaryOptions): number {
	return options.relevance?.scoreFields({
		name: `${asText(node.action)} ${asText(node.label)} ${asText(node.text)}`,
		role: asText(node.role),
		selector: asText(node.selector),
		href: asText(node.href),
		value: asText(node.value),
	}) ?? 0;
}

function rankedActions(actionables: ScanActionable[], options: ScanSummaryOptions): RankedAction[] {
	return actionables.map((node, position) => {
		const key = actionKey(node) || `action:${position}`;
		return { node, position, score: scoreAction(node) + relevanceActionScore(node, options), key };
	});
}

function actionCounts(ranked: RankedAction[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of ranked) counts.set(item.key, (counts.get(item.key) || 0) + 1);
	return counts;
}

function selectPrimaryActions(sortedRanked: RankedAction[], counts: Map<string, number>, limit: number): Record<string, unknown>[] {
	const selected: RankedAction[] = [];
	const seen = new Set<string>();
	const selectedPoints: [number, number][] = [];
	for (const item of sortedRanked) {
		if (seen.has(item.key)) continue;
		seen.add(item.key);
		const pt = pointTuple(item.node.point);
		if (pt && selectedPoints.some(([sx, sy]) => Math.abs(pt[0] - sx) < 20 && Math.abs(pt[1] - sy) < 20)) continue;
		selected.push(item);
		if (pt) selectedPoints.push(pt);
		if (selected.length >= limit) break;
	}
	return selected.map((item) => compactAction(item.node, item.position, counts.get(item.key) || 1));
}

function prepareFormSummary(sortedRanked: RankedAction[]): PreparedForm | undefined {
	const fields = sortedRanked
		.filter((item) => item.node.editable === true && item.node.disabled !== true)
		.slice(0, 6)
		.map((item) => {
			const action = compactAction(item.node, item.position, 1);
			return { i: action.i, k: action.k, name: action.name, flags: action.flags, jsonPath: action.jsonPath };
		});
	if (!fields.length) return undefined;
	const submit = sortedRanked
		.filter((item) => item.node.editable !== true && item.node.disabled !== true)
		.map((item) => compactAction(item.node, item.position, 1))
		.find((item) => item.why || Array.isArray(item.flags) && item.flags.includes("primary"));
	const form: Record<string, unknown> = { name: submit?.name || fields[0]?.name || "form", fields };
	if (submit) form.submit = { i: submit.i, name: submit.name, jsonPath: submit.jsonPath };
	return form as PreparedForm;
}

function summarizeForms(prepared: PreparedForm | undefined, limit: number): Record<string, unknown>[] {
	return prepared && limit > 0 ? [prepared].slice(0, limit) : [];
}

function prepareListSummaries(listHints: ScanListHint[]): Record<string, unknown>[] {
	return listHints.map((item, index) => {
		const hidden = Number(item.hiddenCount || 0);
		const sampleHidden = asArray(item.sampleHidden).map((entry) => cleanSemanticText(entry, 90)).filter(Boolean).slice(0, 2);
		const sample = cleanSemanticText(item.firstItemPreview, 120);
		const containerLabel = cleanSemanticText(item.containerLabel ?? item.containerName ?? item.label, 120);
		const out: Record<string, unknown> = {
			i: index,
			sel: selectorTail(item.selector) || "",
			n: Number(item.itemCount || 0),
			jsonPath: `data.structure.listHints[${index}]`,
		};
		if (containerLabel) out.name = containerLabel;
		if (sample) out.sample = sample;
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

function prepareTextSignalCandidates(lines: string[]): TextSignalCandidate[] {
	const seen = new Set<string>();
	const ranked: TextSignalCandidate[] = [];
	for (const [index, line] of lines.entries()) {
		if (SENSITIVE_LINE_RE.test(line)) continue;
		const text = lineText(line);
		if (text.length < 12) continue;
		const normalized = normalizeText(text);
		if (!normalized || seen.has(normalized)) continue;
		const score = scoreTextSignal(text);
		if (score <= 0) continue;
		seen.add(normalized);
		ranked.push({ index, score, text: cleanInlineText(text, 140), normalized });
	}
	return ranked.sort((a, b) => b.score - a.score || a.index - b.index);
}

function textSignals(candidates: TextSignalCandidate[], actionNames: Set<string>, limit: number): string[] {
	return candidates
		.filter((item) => !actionNames.has(item.normalized))
		.slice(0, limit)
		.sort((a, b) => a.index - b.index)
		.map((item) => item.text);
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
		{ primaryActions: 12, actionRows: 8, lists: 5, listRows: 5, mediaRows: 10, textSignals: 8, headings: 8, interactive: 10, textPreviewChars: 520 },
		{ primaryActions: 10, actionRows: 6, lists: 4, listRows: 4, mediaRows: 8, textSignals: 6, headings: 6, interactive: 6, textPreviewChars: 360 },
		{ primaryActions: 6, actionRows: 4, lists: 3, listRows: 3, mediaRows: 5, textSignals: 4, headings: 4, interactive: 3, textPreviewChars: 180 },
	] : [
		{ primaryActions: 10, actionRows: 6, lists: 4, listRows: 4, mediaRows: 8, textSignals: 6, headings: 6, interactive: 6, textPreviewChars: 360 },
		{ primaryActions: 8, actionRows: 5, lists: 3, listRows: 3, mediaRows: 6, textSignals: 5, headings: 4, interactive: 4, textPreviewChars: 240 },
		{ primaryActions: 5, actionRows: 3, lists: 2, listRows: 2, mediaRows: 4, textSignals: 3, headings: 3, interactive: 2, textPreviewChars: 120 },
		{ primaryActions: 3, actionRows: 0, lists: 2, listRows: 0, mediaRows: 0, textSignals: 2, headings: 0, interactive: 0, textPreviewChars: 0 },
	];
}

function scanEntityContext(item: PageWorldScanBundleV1, options: ScanSummaryOptions): ScanEntityContext {
	const context = options.entityContext || {};
	const url = context.url ?? item.page.url;
	return {
		browserSessionId: context.browserSessionId,
		tabId: context.tabId,
		url,
		observationId: context.observationId ?? `scan:${url || "unknown"}`,
		capturedAt: context.capturedAt ?? item.signals.fingerprint.capturedAt ?? Date.now(),
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function nodeRefId(node: ScanActionable | ScanListHint | ScanCanvasRegion, built: { descriptor: Parameters<typeof summaryRefIdForDescriptor>[0] }, slot: string): string {
	return stringField(node.entityRefs?.[slot]) ?? summaryRefIdForDescriptor(built.descriptor);
}

function entityRefs(entities: Entity[], limit = Number.MAX_SAFE_INTEGER): string[] {
	return entities.map((entity) => entity.ref).filter((ref): ref is string => typeof ref === "string" && !!ref).slice(0, limit);
}

function dedupeEntitiesByRef(entities: Entity[]): Entity[] {
	const seen = new Set<string>();
	const out: Entity[] = [];
	for (const entity of entities) {
		if (seen.has(entity.ref)) continue;
		seen.add(entity.ref);
		out.push(entity);
	}
	return out;
}

function listHintDuplicateNames(listHints: ScanListHint[]): Set<string> {
	const counts = new Map<string, number>();
	for (const [index, item] of listHints.entries()) {
		const built = buildRegionEntityFromListHint(item, { observationId: "scan:list-hint-name", capturedAt: 0 }, index);
		const key = normalizeText(built.entity.name ?? "");
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function buildListRegionEntity(node: ScanListHint, context: ScanEntityContext, index: number, duplicateNames: ReadonlySet<string>): Entity {
	const built = buildRegionEntityFromListHint(node, context, index, duplicateNames);
	return withRegisteredRef(built.entity, nodeRefId(node, built, "listRegion"));
}

export function buildScanEntities(item: PageWorldScanBundleV1, options: ScanSummaryOptions): { entities: Entity[]; primaryEntities: Entity[]; listEntities: Entity[]; visualRegions: Entity[]; referencedEntities: Entity[]; controlsSources: Entity[] } {
	const context = scanEntityContext(item, options);
	const actionables = item.structure.actionables.filter((node) => node.referenceOnly !== true && node.relationOnly !== true);
	const references = item.structure.actionables.filter((node) => node.referenceOnly === true);
	const controlsPairs = item.structure.actionables.filter((node) => node.relationOnly === true);
	const listHints = item.structure.listHints;
	const canvasRegions = item.structure.canvasRegions;
	const actionEntities = dedupeEntities(actionables.map((node) => {
		const built = buildDomEntityFromScanActionable(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "domAction"));
	}));
	// Minimal entities for aria-controls/owns targets (incl. hidden/collapsed) so those relations
	// resolve. Deduped by selector against actionables (a visible target collapses to one entity).
	const referencedEntities = references.map((node) => {
		const built = buildReferencedTargetEntity(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "referencedTarget"));
	});
	// Minimal entities for controls/owns SOURCE elements that were NOT in the actionable list
	// (off-screen). Carries controlsSelectors/ownsSelectors hints for deriveStateRelationAnchors.
	const controlsSourceEntities = controlsPairs.map((node) => {
		const built = buildControlsSourceEntity(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "controlsSource"));
	});
	const visualRegions = dedupeEntities((canvasRegions.length ? canvasRegions : actionables.filter((node) => String(node.tag || "").toLowerCase() === "canvas"))
		.map((node) => {
			const built = buildVisionRegionFromCanvasActionable(node, context);
			return withRegisteredRef(built.entity, nodeRefId(node, built, "visionRegion"));
		}));
	const duplicateListNames = listHintDuplicateNames(listHints);
	const listEntities = dedupeEntities(listHints.map((node, index) => buildListRegionEntity(node, context, index, duplicateListNames)));
	// Hidden/collapsed targets (aria-controls/owns) need their own entities since they're not in
	// actionEntities. For visible targets that were also scanned as actionables, the actionable
	// entity takes precedence via dedupeEntities; the referenced entity is redundant. Keep only
	// referenced entities whose selector is NOT already covered by an actionable.
	const actionableSelectors = new Set(actionEntities.map((e) => typeof e.hints?.selector === "string" ? e.hints.selector : null).filter(Boolean));
	const referencedOnly = referencedEntities.filter((e) => typeof e.hints?.selector !== "string" || !actionableSelectors.has(e.hints.selector as string));
	// controls-source entities: only include those whose selector is not already an actionable.
	const controlsSourceOnly = controlsSourceEntities.filter((e) => typeof e.hints?.selector !== "string" || !actionableSelectors.has(e.hints.selector as string));
	const entities = dedupeEntities([...actionEntities, ...referencedOnly, ...controlsSourceOnly, ...listEntities, ...visualRegions]);
	const referencedSurvivors = [...referencedOnly, ...controlsSourceOnly].filter((ref) => entities.includes(ref));
	const actionableCandidates = actionEntities.filter((entity) => entity.hints?.jsonPath && String(entity.hints.jsonPath).startsWith("data.structure.actionables["));
	// primary_entities is the ONLY DOM set that reaches the AX merge (runtime.ts), so an entity
	// dropped here loses its chance to fuse with its AX twin. High-signal state — aria-current
	// (currentIn) and active checked/selected/pressed — is exactly what the AX/relation layer needs,
	// but page salience can cap it out on a large page. Pin those in beyond the top-N so the DOM
	// state (e.g. the breadcrumb's aria-current, which AX never exposes) survives to the merge.
	const isHighSignal = (entity: Entity) => (entity.state?.current !== undefined && entity.state.current !== false) || entity.state?.checked === true || entity.state?.selected === true || entity.state?.pressed === true;
	const top = actionableCandidates.slice(0, 10);
	const pinned = actionableCandidates.filter((entity) => isHighSignal(entity) && !top.includes(entity)).slice(0, 6);
	const primaryEntities = [...top, ...pinned];
	return { entities, primaryEntities, listEntities, visualRegions, referencedEntities: referencedSurvivors, controlsSources: controlsSourceOnly.filter((e) => entities.includes(e)) };
}

// B6: same-origin classification for link actionables — bounded mechanical compare, no extraction.
function linkSameOrigin(href: unknown, pageUrl: unknown): boolean | undefined {
	if (typeof href !== "string" || !href || typeof pageUrl !== "string" || !pageUrl) return undefined;
	try { return new URL(href).origin === new URL(pageUrl).origin; } catch { return undefined; }
}

function prepareScanSummary(item: PageWorldScanBundleV1, tabs: unknown[], options: ScanSummaryOptions): ScanSummaryPrepared {
	const content = item.content.tree ?? item.content.text;
	const actionables = item.structure.actionables.filter((node) => node.referenceOnly !== true && node.relationOnly !== true);
	const ranked = rankedActions(actionables, options);
	const sortedRanked = [...ranked].sort((a, b) => b.score - a.score || a.position - b.position);
	const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const scanEntities = options.scanEntities ?? buildScanEntities(item, options);
	return {
		item,
		relevance: options.relevance,
		tabs,
		content,
		lines,
		headings: item.content.headings.length ? item.content.headings : headingSignals(lines, Number.MAX_SAFE_INTEGER),
		interactive: item.content.interactive,
		actionables,
		listHints: item.structure.listHints,
		listSummaries: prepareListSummaries(item.structure.listHints),
		mediaCandidates: item.structure.mediaCandidates,
		visibleRows: item.structure.rows,
		rankedActions: ranked,
		sortedRankedActions: sortedRanked,
		actionCounts: actionCounts(ranked),
		preparedForm: prepareFormSummary(sortedRanked),
		textSignalCandidates: prepareTextSignalCandidates(lines),
		scanEntities,
		actionEntityByPath: new Map(scanEntities.entities.map((entity) => [String(entity.hints?.jsonPath || ""), entity])),
		referencedEntities: [...scanEntities.referencedEntities, ...scanEntities.controlsSources].slice(0, FOCUS_REFERENCED_ENTITY_REF_LIMIT),
	};
}

function buildSummary(prepared: ScanSummaryPrepared, limits: Limits, omitted: string[] = []): Summary {
	const { item, tabs, content, lines, headings, interactive, actionables, listHints, listSummaries, mediaCandidates, visibleRows, sortedRankedActions, actionCounts: counts, preparedForm, textSignalCandidates, scanEntities, actionEntityByPath, referencedEntities } = prepared;
	const primaryActions = selectPrimaryActions(sortedRankedActions, counts, limits.primaryActions);
	const actionablesScanned = actionables.length;
	const actionablesReturned = primaryActions.length;
	const actionablesTruncated = actionablesScanned > actionablesReturned;
	const actionablesTruncationMeta = actionablesTruncated
		? { actionablesScanned, actionablesReturned, actionablesTruncated: true as const }
		: { actionablesScanned, actionablesReturned, actionablesTruncated: false as const };
	const warnings: string[] = [];
	if (actionablesTruncated) {
		warnings.push(`actionables truncated from ${actionablesScanned} to ${actionablesReturned} — use browser_observe with selector to target specific page regions`);
	}
	// Cause-agnostic low-substance signal: when a scan finds nothing actionable and effectively no
	// text, the page is likely still loading, behind an anti-bot/consent/login wall, or genuinely
	// empty. Flag the STATE (not a guessed vendor/cause) so the agent waits or verifies instead of
	// reading controlCount:0 as "empty page" and wasting probes. Conservative: a single actionable or
	// any real text suppresses it, so minimal-but-valid pages are not flagged.
	if (actionablesScanned === 0 && content.length < 40) {
		warnings.push(`low-substance page: ${item.stats.nodeCount} nodes, ${content.length} text chars, 0 actionable controls (title="${item.page.title.slice(0, 50)}") — likely an anti-bot/consent/login wall or genuinely empty; verify the title and URL before trusting this scan`);
	}
	const actionNames = new Set(primaryActions.map((action) => normalizeText(action.name)).filter(Boolean));
	const primaryActionsWithEntityRefs = primaryActions.map((action) => {
		const entity = actionEntityByPath.get(String(action.jsonPath || ""));
		return { ...action, ...(entity?.ref ? { entityRef: entity.ref } : {}) };
	});
	const focus: Record<string, unknown> = {
		entityShape: "refs-v1",
		// Clone to avoid shared references rendering as "[Circular]" after redaction.
		primary_actions: primaryActionsWithEntityRefs,
		...(actionablesTruncated ? { actionablesTruncation: actionablesTruncationMeta } : {}),
		forms: summarizeForms(preparedForm, 2),
		lists: listSummaries.slice(0, limits.lists),
		headings: headings.slice(0, limits.headings),
		text_signals: textSignals(textSignalCandidates, actionNames, limits.textSignals),
		primary_entities: entityRefs(scanEntities.primaryEntities),
		list_entities: entityRefs(scanEntities.listEntities, limits.lists),
		visual_regions: entityRefs(scanEntities.visualRegions, 4),
		referenced_entities: entityRefs(referencedEntities, FOCUS_REFERENCED_ENTITY_REF_LIMIT),
	};
	const relevance = prepared.relevance;
	return {
		summaryVersion: 3,
		url: item.page.url,
		title: item.page.title,
		readyState: item.page.readyState,
		contentChars: content.length,
		lineCount: lines.length,
		truncated: item.stats.truncated,
		nodeCount: item.stats.nodeCount,
		frameNotes: item.frames.notes,
		tabs_count: tabs.length,
		...(relevance && Number(relevance.boosted || 0) > 0 ? { relevance: { boosted: relevance.boosted, signals: Array.isArray(relevance.signals) ? relevance.signals : [] } } : {}),
		page: {
			contentChars: content.length,
			lineCount: lines.length,
			nodeCount: item.stats.nodeCount,
			truncated: item.stats.truncated,
			tabs_count: tabs.length,
		},
		focus,
		...(warnings.length ? { warnings } : {}),
		artifact_hints: {
			jsonPaths: {
				content: "data.content",
				actionables: "data.structure.actionables",
				listHints: "data.structure.listHints",
				mediaCandidates: "data.structure.mediaCandidates",
				rows: "data.structure.rows",
			},
			preferredReads: [
				{ label: "DOM-ordered visible rows (text+href)", jsonPath: "data.structure.rows" },
				{ label: "all actionables with full selectors", jsonPath: "data.structure.actionables" },
				{ label: "full simplified DOM/text", jsonPath: "data.content" },
				{ label: "visible media candidates (src+geometry)", jsonPath: "data.structure.mediaCandidates" },
				{ label: "repeated list hints", jsonPath: "data.structure.listHints" },
			],
		},
		listHints: summaryTable(listHints, [
			{ key: "selector", value: (node) => node.selector },
			{ key: "itemCount", value: (node) => node.itemCount },
			{ key: "hiddenCount", value: (node) => node.hiddenCount },
			{ key: "firstItemPreview", value: (node) => node.firstItemPreview },
		], limits.listRows),
		...(!omitted.includes("mediaCandidates") && mediaCandidates.length > 0 ? {
			mediaCandidates: summaryTable(mediaCandidates.slice(0, 40), [
				{ key: "tag", value: (node: ScanMediaCandidate) => node.tag },
				{ key: "src", value: (node: ScanMediaCandidate) => node.src },
				{ key: "poster", value: (node: ScanMediaCandidate) => node.poster },
				{ key: "alt", value: (node: ScanMediaCandidate) => node.alt || node.title },
				{ key: "sameOrigin", value: (node: ScanMediaCandidate) => node.sameOrigin },
				{ key: "naturalWidth", value: (node: ScanMediaCandidate) => node.naturalWidth ?? node.videoWidth },
				{ key: "naturalHeight", value: (node: ScanMediaCandidate) => node.naturalHeight ?? node.videoHeight },
				{ key: "selector", value: (node: ScanMediaCandidate) => node.selector },
			], limits.mediaRows),
		} : {}),
		// DOM-ordered, capped, viewport-visible text/link rows.
		// Hard boundary: perception only — text/href/geometry/container hints, no semantic/source inference.
		...(!omitted.includes("rows") && visibleRows.length > 0 ? {
			rows: summaryTable(visibleRows.slice(0, 40), [
				{ key: "text", value: (node: ScanRow) => node.text },
				{ key: "href", value: (node: ScanRow) => node.href },
				{ key: "sameOrigin", value: (node: ScanRow) => node.sameOrigin },
				{ key: "selector", value: (node: ScanRow) => node.selector },
			], 40),
		} : {}),
		actionables: summaryTable(actionables, [
			{ key: "index", value: (node) => node.index },
			{ key: "tag", value: (node) => node.tag },
			{ key: "role", value: (node) => node.role },
			{ key: "action", value: (node) => node.action || "" },
			{ key: "label", value: (node) => node.label || node.text },
			{ key: "selector", value: (node) => node.selector },
			{ key: "point", value: (node) => node.point },
			{ key: "hitOk", value: (node) => node.hitOk },
			// Link identity so link-inventory tasks do not need custom JS; href is resolved/captured
			// in the scan (buildScanScript), sameOrigin is a mechanical origin compare vs the page URL.
			{ key: "href", value: (node) => node.href },
			{ key: "sameOrigin", value: (node) => linkSameOrigin(node.href, item.page.url) },
		], limits.actionRows),
		interactive: interactive.slice(0, limits.interactive),
		// Keep a distinct array from focus.headings so redaction does not collapse the shared reference.
		headings: headings.slice(0, limits.headings),
		textPreview: limits.textPreviewChars > 0 ? textPreview(content, limits.textPreviewChars) : "",
		...(omitted.length ? { summaryOmitted: omitted } : {}),
	};
}

export function summarizeScanData(data: PageWorldScanBundleV1, tabs: unknown[] = [], options: ScanSummaryOptions = {}): Summary {
	const budget = scanBudget(options);
	const sets = limitSets(options);
	const prepared = prepareScanSummary(data, tabs, options);
	for (const [index, limits] of sets.entries()) {
		const omitted = index === 0 ? [] : ["interactive", "textPreview", "mediaCandidates", "rows"];
		const summary = buildSummary(prepared, limits, omitted);
		if (stableLength(summary) <= budget || index === sets.length - 1) return summary;
	}
	return buildSummary(prepared, sets[sets.length - 1], ["interactive", "textPreview", "mediaCandidates", "rows"]);
}

export function scanEntitiesForEnvelope(data: PageWorldScanBundleV1, options: ScanSummaryOptions = {}): Entity[] {
	const built = options.scanEntities ?? buildScanEntities(data, options);
	return scanEntitiesFromGroups(built);
}

export function scanEntitiesFromGroups(built: ReturnType<typeof buildScanEntities>): Entity[] {
	return dedupeEntitiesByRef([...built.entities, ...built.primaryEntities, ...built.listEntities, ...built.visualRegions, ...built.referencedEntities, ...built.controlsSources]);
}
