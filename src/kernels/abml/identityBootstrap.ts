import { isRecord } from "../../utils/records.js";

export type SnapshotGeometryEntry = {
	backendNodeId: number;
	bounds: { x: number; y: number; w: number; h: number };
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
	scanRect?: { x: number; y: number; w: number; h: number };
	snapshotBounds?: { x: number; y: number; w: number; h: number };
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
	data: Record<string, unknown>;
	stats: BackendNodeIdBootstrapStats;
};

const MATCH_IOU_THRESHOLD = 0.9;

function num(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function rectFromScan(value: unknown, scrollX: number, scrollY: number): { x: number; y: number; w: number; h: number } | undefined {
	if (!isRecord(value)) return undefined;
	const x = num(value.x);
	const y = num(value.y);
	const w = num(value.width ?? value.w);
	const h = num(value.height ?? value.h);
	if (x === undefined || y === undefined || w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
	return { x: x + scrollX, y: y + scrollY, w, h };
}

function scaledRect(rect: { x: number; y: number; w: number; h: number }, scale: number): { x: number; y: number; w: number; h: number } {
	const divisor = scale > 0 ? scale : 1;
	return { x: rect.x / divisor, y: rect.y / divisor, w: rect.w / divisor, h: rect.h / divisor };
}

function rectArea(rect: { w: number; h: number }): number {
	return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function rectIou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
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
	return {
		matched: records.filter((item) => item.status === "matched").length,
		ambiguous: records.filter((item) => item.status === "ambiguous").length,
		stale: records.filter((item) => item.status === "stale").length,
		missing: records.filter((item) => item.status === "missing").length,
		unsupported: records.filter((item) => item.status === "unsupported").length,
	};
}

export function bootstrapScanBackendNodeIds(
	data: Record<string, unknown>,
	entries: SnapshotGeometryEntry[],
	options: { scanCapturedAt?: number; scanCapturedAtIso?: string; snapshotStartedAt?: string; snapshotEndedAt?: string } = {},
): BackendNodeIdBootstrapResult {
	const viewport = isRecord(data.viewport) ? data.viewport : {};
	const scrollX = num(viewport.scrollX) ?? 0;
	const scrollY = num(viewport.scrollY) ?? 0;
	const scale = Math.max(1, num(viewport.devicePixelRatio) ?? 1);
	const viewportKnown = num(viewport.scrollX) !== undefined && num(viewport.scrollY) !== undefined;
	const indexedEntries = entries
		.filter((entry) => Number.isFinite(entry.backendNodeId) && entry.backendNodeId > 0 && rectArea(entry.bounds) > 0)
		.map((entry) => ({ ...entry, scaledBounds: scaledRect(entry.bounds, scale) }));
	const byId = new Map<string, typeof indexedEntries[number]>();
	for (const entry of indexedEntries) {
		const id = entry.attrs?.id;
		if (id && !byId.has(id)) byId.set(id, entry);
	}
	const actionables = Array.isArray(data.actionables) ? data.actionables : [];
	const records: BackendNodeIdBootstrapRecord[] = [];
	const nextActionables = actionables.map((item, index) => {
		if (!isRecord(item)) return item;
		const jsonPath = `data.actionables[${Number(item.index ?? index)}]`;
		const selector = typeof item.selector === "string" ? item.selector : undefined;
		const scanRect = rectFromScan(item.rect, scrollX, scrollY);
		if (!scanRect || !indexedEntries.length) {
			records.push({ jsonPath, selector, status: "unsupported", reason: !scanRect ? "scan-rect-unavailable" : "snapshot-geometry-unavailable" });
			return item;
		}
		const candidates = indexedEntries
			.map((entry) => ({ entry, iou: rectIou(scanRect, entry.scaledBounds) }))
			.filter((candidate) => candidate.iou >= MATCH_IOU_THRESHOLD)
			.sort((a, b) => b.iou - a.iou || a.entry.backendNodeId - b.entry.backendNodeId);
		if (candidates.length > 1) {
			records.push({ jsonPath, selector, status: "ambiguous", reason: "multiple-high-iou-candidates", candidateCount: candidates.length, scanRect, iou: Number(candidates[0]!.iou.toFixed(3)) });
			return { ...item, backendNodeIdBootstrap: { status: "ambiguous", reason: "multiple-high-iou-candidates", candidateCount: candidates.length } };
		}
		if (candidates.length === 1) {
			const match = candidates[0]!;
			const iou = Number(match.iou.toFixed(3));
			records.push({ jsonPath, selector, status: "matched", reason: "unique-high-iou", backendNodeId: match.entry.backendNodeId, iou, candidateCount: 1, scanRect, snapshotBounds: match.entry.scaledBounds });
			return { ...item, backendNodeId: match.entry.backendNodeId, backendNodeIdBootstrap: { status: "matched", reason: "unique-high-iou", iou } };
		}
		const simpleId = idFromSimpleSelector(selector);
		const selectorEntry = simpleId ? byId.get(simpleId) : undefined;
		if (selectorEntry) {
			const iou = Number(rectIou(scanRect, selectorEntry.scaledBounds).toFixed(3));
			records.push({ jsonPath, selector, status: "stale", reason: "selector-node-geometry-drift", backendNodeId: selectorEntry.backendNodeId, iou, candidateCount: 0, scanRect, snapshotBounds: selectorEntry.scaledBounds });
			return { ...item, backendNodeIdBootstrap: { status: "stale", reason: "selector-node-geometry-drift", iou } };
		}
		records.push({ jsonPath, selector, status: "missing", reason: "no-high-iou-candidate", candidateCount: 0, scanRect });
		return { ...item, backendNodeIdBootstrap: { status: "missing", reason: "no-high-iou-candidate" } };
	});
	const counts = countStatuses(records);
	const sampleWindowMs = options.scanCapturedAt !== undefined && options.snapshotEndedAt ? Math.max(0, Date.parse(options.snapshotEndedAt) - options.scanCapturedAt) : undefined;
	const stats: BackendNodeIdBootstrapStats = {
		total: records.length,
		...counts,
		coverage: records.length ? Number((counts.matched / records.length).toFixed(3)) : 0,
		matchThreshold: MATCH_IOU_THRESHOLD,
		snapshotScaleDivisor: scale,
		viewportKnown,
		...(sampleWindowMs !== undefined ? { sampleWindowMs } : {}),
		...(options.scanCapturedAtIso ? { scanCapturedAt: options.scanCapturedAtIso } : {}),
		...(options.snapshotStartedAt ? { snapshotStartedAt: options.snapshotStartedAt } : {}),
		...(options.snapshotEndedAt ? { snapshotEndedAt: options.snapshotEndedAt } : {}),
		records,
	};
	return { data: { ...data, actionables: nextActionables, backendNodeIdBootstrap: stats }, stats };
}
