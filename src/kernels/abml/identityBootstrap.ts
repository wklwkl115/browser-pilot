import { isRecord } from "../../utils/records.js";
import type { PageWorldScanBundleV1, ScanActionable } from "./pageWorldScan.js";

type Rect = { x: number; y: number; w: number; h: number };
type IndexedEntry = SnapshotGeometryEntry & { scaledBounds: Rect };
type BootstrapOptions = { scanCapturedAt?: number; scanCapturedAtIso?: string; snapshotStartedAt?: string; snapshotEndedAt?: string };

export type SnapshotGeometryEntry = {
	backendNodeId: number;
	bounds: Rect;
	attrs?: Record<string, string>;
};

export type BackendNodeIdBootstrapStatus = "matched" | "ambiguous" | "stale" | "missing" | "unsupported";

export type BackendNodeIdBootstrapRecord = {
	jsonPath: string;
	selector?: string;
	status: BackendNodeIdBootstrapStatus;
	reason: string;
	backendNodeId?: number;
	iou?: number;
	candidateCount?: number;
	scanRect?: Rect;
	snapshotBounds?: Rect;
};

export type BackendNodeIdBootstrapStats = {
	total: number;
	matched: number;
	ambiguous: number;
	stale: number;
	missing: number;
	unsupported: number;
	coverage: number;
	matchThreshold: number;
	snapshotScaleDivisor: number;
	viewportKnown: boolean;
	sampleWindowMs?: number;
	scanCapturedAt?: string;
	snapshotStartedAt?: string;
	snapshotEndedAt?: string;
	records: BackendNodeIdBootstrapRecord[];
};

export type BackendNodeIdBootstrapResult = {
	data: PageWorldScanBundleV1;
	stats: BackendNodeIdBootstrapStats;
};

const MATCH_IOU_THRESHOLD = 0.9;

function num(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function rectFromScan(value: unknown, scrollX: number, scrollY: number): Rect | undefined {
	if (!isRecord(value)) return undefined;
	const x = num(value.x);
	const y = num(value.y);
	const w = num(value.width ?? value.w);
	const h = num(value.height ?? value.h);
	if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
	return { x: x + scrollX, y: y + scrollY, w, h };
}

function scaledRect(rect: Rect, scale: number): Rect {
	const divisor = scale > 0 ? scale : 1;
	return { x: rect.x / divisor, y: rect.y / divisor, w: rect.w / divisor, h: rect.h / divisor };
}

function rectArea(rect: { w: number; h: number }): number {
	return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function rectIou(a: Rect, b: Rect): number {
	const ix = Math.max(a.x, b.x);
	const iy = Math.max(a.y, b.y);
	const ix2 = Math.min(a.x + a.w, b.x + b.w);
	const iy2 = Math.min(a.y + a.h, b.y + b.h);
	const intersection = Math.max(0, ix2 - ix) * Math.max(0, iy2 - iy);
	const union = rectArea(a) + rectArea(b) - intersection;
	return union > 0 ? intersection / union : 0;
}

function idFromSimpleSelector(selector: unknown): string | undefined {
	if (typeof selector !== "string") return undefined;
	const match = /^#([A-Za-z0-9_-]+)$/.exec(selector.trim());
	return match?.[1];
}

function countStatuses(records: BackendNodeIdBootstrapRecord[]): Omit<BackendNodeIdBootstrapStats, "total" | "coverage" | "matchThreshold" | "snapshotScaleDivisor" | "viewportKnown" | "records" | "sampleWindowMs" | "scanCapturedAt" | "snapshotStartedAt" | "snapshotEndedAt"> {
	const counts = { matched: 0, ambiguous: 0, stale: 0, missing: 0, unsupported: 0 };
	for (const item of records) counts[item.status] += 1;
	return counts;
}

function indexEntries(entries: SnapshotGeometryEntry[], scale: number): IndexedEntry[] {
	return entries
		.filter((entry) => Number.isFinite(entry.backendNodeId) && entry.backendNodeId > 0 && rectArea(entry.bounds) > 0)
		.map((entry) => ({ ...entry, scaledBounds: scaledRect(entry.bounds, scale) }));
}

function entriesById(entries: IndexedEntry[]): Map<string, IndexedEntry> {
	const byId = new Map<string, IndexedEntry>();
	for (const entry of entries) if (entry.attrs?.id && !byId.has(entry.attrs.id)) byId.set(entry.attrs.id, entry);
	return byId;
}

function actionableIndex(item: ScanActionable, index: number): number {
	const explicit = num(item.index);
	return explicit !== undefined && explicit >= 0 ? Math.floor(explicit) : index;
}

function actionableJsonPath(item: ScanActionable, index: number): string {
	return `data.structure.actionables[${actionableIndex(item, index)}]`;
}

function highIouSummary(scanRect: Rect, entries: IndexedEntry[]): { count: number; best?: IndexedEntry; bestIou: number } {
	let count = 0;
	let best: IndexedEntry | undefined;
	let bestIou = 0;
	for (const entry of entries) {
		const iou = rectIou(scanRect, entry.scaledBounds);
		if (iou < MATCH_IOU_THRESHOLD) continue;
		count += 1;
		if (!best || iou > bestIou || (iou === bestIou && entry.backendNodeId < best.backendNodeId)) {
			best = entry;
			bestIou = iou;
		}
	}
	return { count, best, bestIou };
}

function sampleWindowMs(options: BootstrapOptions): number | undefined {
	if (options.scanCapturedAt === undefined || !options.snapshotEndedAt) return undefined;
	const endedAt = Date.parse(options.snapshotEndedAt);
	if (!Number.isFinite(endedAt)) return undefined;
	return Math.max(0, endedAt - options.scanCapturedAt);
}

function buildStats(records: BackendNodeIdBootstrapRecord[], scale: number, viewportKnown: boolean, options: BootstrapOptions): BackendNodeIdBootstrapStats {
	const counts = countStatuses(records);
	const windowMs = sampleWindowMs(options);
	return {
		total: records.length,
		...counts,
		coverage: records.length ? Number((counts.matched / records.length).toFixed(3)) : 0,
		matchThreshold: MATCH_IOU_THRESHOLD,
		snapshotScaleDivisor: scale,
		viewportKnown,
		...(windowMs === undefined ? {} : { sampleWindowMs: windowMs }),
		...(options.scanCapturedAtIso ? { scanCapturedAt: options.scanCapturedAtIso } : {}),
		...(options.snapshotStartedAt ? { snapshotStartedAt: options.snapshotStartedAt } : {}),
		...(options.snapshotEndedAt ? { snapshotEndedAt: options.snapshotEndedAt } : {}),
		records,
	};
}

function bootstrapActionable(item: ScanActionable, index: number, entries: IndexedEntry[], byId: Map<string, IndexedEntry>, scrollX: number, scrollY: number) {
	const jsonPath = actionableJsonPath(item, index);
	const selector = typeof item.selector === "string" ? item.selector : undefined;
	const scanRect = rectFromScan(item.documentRect ?? item.rect, scrollX, scrollY);
	if (!scanRect || !entries.length) return { item, record: { jsonPath, selector, status: "unsupported" as const, reason: !scanRect ? "scan-rect-unavailable" : "snapshot-geometry-unavailable" } };
	const summary = highIouSummary(scanRect, entries);
	if (summary.count > 1) return { item: { ...item, backendNodeIdBootstrap: { status: "ambiguous", reason: "multiple-high-iou-candidates", candidateCount: summary.count } }, record: { jsonPath, selector, status: "ambiguous" as const, reason: "multiple-high-iou-candidates", candidateCount: summary.count, scanRect, iou: Number(summary.bestIou.toFixed(3)) } };
	if (summary.best) {
		const iou = Number(summary.bestIou.toFixed(3));
		return { item: { ...item, backendNodeId: summary.best.backendNodeId, backendNodeIdBootstrap: { status: "matched", reason: "unique-high-iou", iou } }, record: { jsonPath, selector, status: "matched" as const, reason: "unique-high-iou", backendNodeId: summary.best.backendNodeId, iou, candidateCount: 1, scanRect, snapshotBounds: summary.best.scaledBounds } };
	}
	const selectorEntry = byId.get(idFromSimpleSelector(selector) || "");
	if (!selectorEntry) return { item: { ...item, backendNodeIdBootstrap: { status: "missing", reason: "no-high-iou-candidate" } }, record: { jsonPath, selector, status: "missing" as const, reason: "no-high-iou-candidate", candidateCount: 0, scanRect } };
	const iou = Number(rectIou(scanRect, selectorEntry.scaledBounds).toFixed(3));
	return { item: { ...item, backendNodeIdBootstrap: { status: "stale", reason: "selector-node-geometry-drift", iou } }, record: { jsonPath, selector, status: "stale" as const, reason: "selector-node-geometry-drift", backendNodeId: selectorEntry.backendNodeId, iou, candidateCount: 0, scanRect, snapshotBounds: selectorEntry.scaledBounds } };
}

export function bootstrapScanBackendNodeIds(data: PageWorldScanBundleV1, entries: SnapshotGeometryEntry[], options: BootstrapOptions = {}): BackendNodeIdBootstrapResult {
	const scrollX = 0;
	const scrollY = 0;
	const scale = 1;
	const viewportKnown = data.structure.actionables.some((item) => item.documentRect !== undefined);
	const indexedEntries = indexEntries(entries, scale);
	const byId = entriesById(indexedEntries);
	const actionables = data.structure.actionables;
	const records: BackendNodeIdBootstrapRecord[] = [];
	const nextActionables = actionables.map((item, index) => {
		const resolved = bootstrapActionable(item, index, indexedEntries, byId, scrollX, scrollY);
		records.push(resolved.record);
		return resolved.item as ScanActionable;
	});
	const stats = buildStats(records, scale, viewportKnown, options);
	return { data: { ...data, structure: { ...data.structure, actionables: nextActionables } }, stats };
}
