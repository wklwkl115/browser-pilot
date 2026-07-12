export const PAGE_WORLD_SCAN_SCHEMA = "browser-page-scan/v1" as const;

export interface ScanRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScanBounds {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ScanPoint { x: number; y: number }

export interface ScanHitTarget {
	tag: string;
	id: string;
	class: string;
	text: string;
	inputLabel?: string;
}

export interface ScanActionable {
	index?: number;
	selector?: string;
	tag?: string;
	kind?: string;
	role?: string | null;
	action?: string;
	label?: string;
	displayLabel?: string;
	text?: string;
	value?: string;
	clickable?: boolean;
	editable?: boolean;
	disabled?: boolean;
	focused?: boolean;
	checked?: boolean;
	selected?: boolean;
	pressed?: boolean;
	expanded?: boolean;
	visible?: boolean;
	inViewport?: boolean;
	current?: string;
	inputKind?: string;
	controlsSelectors?: string[];
	ownsSelectors?: string[];
	expandedTargetSelectors?: string[];
	position?: string;
	edgeUtility?: boolean;
	handlers?: string[];
	rect?: ScanRect;
	documentRect?: ScanRect;
	point?: ScanPoint;
	hitOk?: boolean | null;
	hitTarget?: ScanHitTarget | null;
	href?: string;
	occluderSelector?: string;
	priority?: number;
	name?: string;
	ariaLabel?: string;
	ref?: string;
	hidden?: boolean;
	referenceOnly?: boolean;
	relationOnly?: boolean;
	sourceSelector?: string;
	sourceRole?: string | null;
	sourceName?: string;
	targetId?: string;
	cdpTargetId?: string;
	backendNodeId?: number;
	backendNodeIdBootstrap?: Record<string, unknown>;
	entityRefs?: Record<string, string>;
}

export interface ScanRow {
	text: string;
	selector: string;
	rect: ScanBounds;
	href?: string;
	sameOrigin?: boolean;
	containerHint?: string;
}

export interface ScanListHint {
	selector: string;
	itemCount: number;
	hiddenCount: number;
	firstItemPreview: string;
	sampleHidden: string[];
	containerLabel?: string;
	containerName?: string;
	label?: string;
	containerSelector?: string;
	heading?: string;
	nearestHeading?: string;
	landmarkName?: string;
	parentLabel?: string;
	entityRefs?: Record<string, string>;
}

export interface ScanCanvasRegion {
	index: number;
	tag: string;
	role: string;
	action: string;
	label: string;
	selector: string;
	point: ScanPoint;
	rect: ScanRect;
	hitOk: boolean | null;
	clickable: boolean;
	text?: string;
	visible?: boolean;
	entityRefs?: Record<string, string>;
}

export interface ScanMediaCandidate {
	index: number;
	tag: string;
	selector: string;
	rect: ScanBounds;
	src?: string;
	poster?: string;
	alt?: string;
	title?: string;
	sameOrigin?: boolean;
	naturalWidth?: number;
	naturalHeight?: number;
	videoWidth?: number;
	videoHeight?: number;
}

export interface ScanFrameNote {
	src: string;
	accessible: boolean;
	title?: string;
	error?: string;
}

export interface ScanGrowthProbe {
	supported: boolean;
	candidateCount: number;
	reason?: string;
	target?: string;
	selector?: string;
	beforeCount?: number;
	afterCount?: number;
	beforeScrollTop?: number;
	afterScrollTop?: number;
	restoredScrollTop?: boolean;
	beforeScrollHeight?: number;
	afterScrollHeight?: number;
	beforeFirstText?: string;
	afterFirstText?: string;
	intersectionSupported?: boolean;
	beforeIntersectingCount?: number;
	afterIntersectingCount?: number;
	countGrew?: boolean;
	heightGrew?: boolean;
	windowShifted?: boolean;
	elapsedMs: number;
}

export interface ScanPageFingerprint {
	changeSeq: number;
	pageEpoch?: string;
	documentId?: string;
	url?: string;
	title?: string;
	readyState?: string;
	visibleCount?: number;
	interactiveCount?: number;
	capturedAt?: number;
}

export interface PageWorldScanBundleV1 {
	schema: typeof PAGE_WORLD_SCAN_SCHEMA;
	page: { url: string; title: string; readyState: string; language?: string };
	content: { text: string; tree?: string; headings: string[]; interactive: string[] };
	structure: {
		actionables: ScanActionable[];
		rows: ScanRow[];
		listHints: ScanListHint[];
		canvasRegions: ScanCanvasRegion[];
		mediaCandidates: ScanMediaCandidate[];
	};
	frames: { notes: ScanFrameNote[] };
	signals: { fingerprint: ScanPageFingerprint; growthProbe?: ScanGrowthProbe };
	stats: { nodeCount: number; outputChars: number; truncated: boolean };
}

export type ScanBundleValidation =
	| { ok: true; value: PageWorldScanBundleV1 }
	| { ok: false; issues: string[] };

const stringSchema = { type: "string" } as const;
const numberSchema = { type: "number" } as const;
const booleanSchema = { type: "boolean" } as const;
const nullableStringSchema = { anyOf: [stringSchema, { type: "null" }] } as const;
const nullableBooleanSchema = { anyOf: [booleanSchema, { type: "null" }] } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;
const pointSchema = {
	type: "object",
	properties: { x: numberSchema, y: numberSchema },
	required: ["x", "y"],
	additionalProperties: false,
} as const;
const rectSchema = {
	type: "object",
	properties: { x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema },
	required: ["x", "y", "width", "height"],
	additionalProperties: false,
} as const;
const boundsSchema = {
	type: "object",
	properties: { x: numberSchema, y: numberSchema, w: numberSchema, h: numberSchema },
	required: ["x", "y", "w", "h"],
	additionalProperties: false,
} as const;
const hitTargetSchema = {
	type: "object",
	properties: { tag: stringSchema, id: stringSchema, class: stringSchema, text: stringSchema, inputLabel: stringSchema },
	required: ["tag", "id", "class", "text"],
	additionalProperties: false,
} as const;

const actionableProperties = {
	index: numberSchema, selector: stringSchema, tag: stringSchema, kind: stringSchema, role: nullableStringSchema, action: stringSchema,
	label: stringSchema, displayLabel: stringSchema, text: stringSchema, value: stringSchema, clickable: booleanSchema, editable: booleanSchema,
	disabled: booleanSchema, focused: booleanSchema, checked: booleanSchema, selected: booleanSchema, pressed: booleanSchema,
	expanded: booleanSchema, visible: booleanSchema, inViewport: booleanSchema, current: stringSchema, inputKind: stringSchema,
	controlsSelectors: stringArraySchema, ownsSelectors: stringArraySchema, expandedTargetSelectors: stringArraySchema,
	position: stringSchema, edgeUtility: booleanSchema, handlers: stringArraySchema, rect: rectSchema, documentRect: rectSchema,
	point: pointSchema, hitOk: nullableBooleanSchema, hitTarget: { anyOf: [hitTargetSchema, { type: "null" }] }, href: stringSchema,
	occluderSelector: stringSchema, priority: numberSchema, name: stringSchema, ariaLabel: stringSchema, ref: stringSchema, hidden: booleanSchema, referenceOnly: booleanSchema,
	relationOnly: booleanSchema, sourceSelector: stringSchema, sourceRole: nullableStringSchema, sourceName: stringSchema,
	targetId: stringSchema, cdpTargetId: stringSchema,
} as const;

const growthProbeProperties = {
	supported: booleanSchema, candidateCount: numberSchema, reason: stringSchema, target: stringSchema, selector: stringSchema,
	beforeCount: numberSchema, afterCount: numberSchema, beforeScrollTop: numberSchema, afterScrollTop: numberSchema,
	restoredScrollTop: booleanSchema, beforeScrollHeight: numberSchema, afterScrollHeight: numberSchema,
	beforeFirstText: stringSchema, afterFirstText: stringSchema, intersectionSupported: booleanSchema,
	beforeIntersectingCount: numberSchema, afterIntersectingCount: numberSchema, countGrew: booleanSchema,
	heightGrew: booleanSchema, windowShifted: booleanSchema, elapsedMs: numberSchema,
} as const;

export const PAGE_WORLD_SCAN_BUNDLE_JSON_SCHEMA = {
	$id: PAGE_WORLD_SCAN_SCHEMA,
	type: "object",
	properties: {
		schema: { const: PAGE_WORLD_SCAN_SCHEMA },
		page: {
			type: "object",
			properties: { url: stringSchema, title: stringSchema, readyState: stringSchema, language: stringSchema },
			required: ["url", "title", "readyState"],
			additionalProperties: false,
		},
		content: {
			type: "object",
			properties: { text: stringSchema, tree: stringSchema, headings: stringArraySchema, interactive: stringArraySchema },
			required: ["text", "headings", "interactive"],
			additionalProperties: false,
		},
		structure: {
			type: "object",
			properties: {
				actionables: { type: "array", items: { type: "object", properties: actionableProperties, additionalProperties: false } },
				rows: { type: "array", items: { type: "object", properties: { text: stringSchema, selector: stringSchema, rect: boundsSchema, href: stringSchema, sameOrigin: booleanSchema, containerHint: stringSchema }, required: ["text", "selector", "rect"], additionalProperties: false } },
				listHints: { type: "array", items: { type: "object", properties: { selector: stringSchema, itemCount: numberSchema, hiddenCount: numberSchema, firstItemPreview: stringSchema, sampleHidden: stringArraySchema, containerLabel: stringSchema, containerName: stringSchema, label: stringSchema, containerSelector: stringSchema, heading: stringSchema, nearestHeading: stringSchema, landmarkName: stringSchema, parentLabel: stringSchema }, required: ["selector", "itemCount", "hiddenCount", "firstItemPreview", "sampleHidden"], additionalProperties: false } },
				canvasRegions: { type: "array", items: { type: "object", properties: { index: numberSchema, tag: stringSchema, role: stringSchema, action: stringSchema, label: stringSchema, selector: stringSchema, point: pointSchema, rect: rectSchema, hitOk: nullableBooleanSchema, clickable: booleanSchema, text: stringSchema, visible: booleanSchema }, required: ["index", "tag", "role", "action", "label", "selector", "point", "rect", "hitOk", "clickable"], additionalProperties: false } },
				mediaCandidates: { type: "array", items: { type: "object", properties: { index: numberSchema, tag: stringSchema, selector: stringSchema, rect: boundsSchema, src: stringSchema, poster: stringSchema, alt: stringSchema, title: stringSchema, sameOrigin: booleanSchema, naturalWidth: numberSchema, naturalHeight: numberSchema, videoWidth: numberSchema, videoHeight: numberSchema }, required: ["index", "tag", "selector", "rect"], additionalProperties: false } },
			},
			required: ["actionables", "rows", "listHints", "canvasRegions", "mediaCandidates"],
			additionalProperties: false,
		},
		frames: { type: "object", properties: { notes: { type: "array", items: { type: "object", properties: { src: stringSchema, accessible: booleanSchema, title: stringSchema, error: stringSchema }, required: ["src", "accessible"], additionalProperties: false } } }, required: ["notes"], additionalProperties: false },
		signals: {
			type: "object",
			properties: {
				fingerprint: { type: "object", properties: { changeSeq: numberSchema, pageEpoch: stringSchema, documentId: stringSchema, url: stringSchema, title: stringSchema, readyState: stringSchema, visibleCount: numberSchema, interactiveCount: numberSchema, capturedAt: numberSchema }, required: ["changeSeq"], additionalProperties: false },
				growthProbe: { type: "object", properties: growthProbeProperties, required: ["supported", "candidateCount", "elapsedMs"], additionalProperties: false },
			},
			required: ["fingerprint"],
			additionalProperties: false,
		},
		stats: { type: "object", properties: { nodeCount: numberSchema, outputChars: numberSchema, truncated: booleanSchema }, required: ["nodeCount", "outputChars", "truncated"], additionalProperties: false },
	},
	required: ["schema", "page", "content", "structure", "frames", "signals", "stats"],
	additionalProperties: false,
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) if (!allowedSet.has(key)) issues.push(`${path}/${key}: unknown property`);
}

function finiteNumber(value: unknown, path: string, issues: string[]): void {
	if (typeof value !== "number" || !Number.isFinite(value)) issues.push(`${path}: expected finite number`);
}

function stringValue(value: unknown, path: string, issues: string[]): void {
	if (typeof value !== "string") issues.push(`${path}: expected string`);
}

function booleanValue(value: unknown, path: string, issues: string[]): void {
	if (typeof value !== "boolean") issues.push(`${path}: expected boolean`);
}

function optional(value: unknown, check: (value: unknown) => boolean, path: string, expected: string, issues: string[]): void {
	if (value !== undefined && !check(value)) issues.push(`${path}: expected ${expected}`);
}

function stringArray(value: unknown, path: string, issues: string[]): void {
	if (!Array.isArray(value)) {
		issues.push(`${path}: expected array`);
		return;
	}
	for (let index = 0; index < value.length; index += 1) stringValue(value[index], `${path}/${index}`, issues);
}

function objectArray(value: unknown, path: string, issues: string[], validate: (item: Record<string, unknown>, path: string, issues: string[]) => void): void {
	if (!Array.isArray(value)) {
		issues.push(`${path}: expected array`);
		return;
	}
	for (let index = 0; index < value.length; index += 1) {
		const item = record(value[index]);
		if (!item) issues.push(`${path}/${index}: expected object`);
		else validate(item, `${path}/${index}`, issues);
	}
}

function validatePoint(value: unknown, path: string, issues: string[]): void {
	const item = record(value);
	if (!item) return void issues.push(`${path}: expected object`);
	exactKeys(item, ["x", "y"], path, issues);
	finiteNumber(item.x, `${path}/x`, issues);
	finiteNumber(item.y, `${path}/y`, issues);
}

function validateRect(value: unknown, path: string, issues: string[], bounds = false): void {
	const item = record(value);
	if (!item) return void issues.push(`${path}: expected object`);
	const keys = bounds ? ["x", "y", "w", "h"] as const : ["x", "y", "width", "height"] as const;
	exactKeys(item, keys, path, issues);
	for (const key of keys) finiteNumber(item[key], `${path}/${key}`, issues);
}

const actionableWireKeys = Object.keys(actionableProperties);
function validateActionable(item: Record<string, unknown>, path: string, issues: string[]): void {
	exactKeys(item, actionableWireKeys, path, issues);
	if (typeof item.selector !== "string" && typeof item.sourceSelector !== "string") issues.push(`${path}: expected selector or sourceSelector`);
	for (const key of ["index", "priority"] as const) optional(item[key], (value) => typeof value === "number" && Number.isFinite(value), `${path}/${key}`, "finite number", issues);
	for (const key of ["selector", "tag", "kind", "action", "label", "displayLabel", "text", "value", "current", "inputKind", "position", "href", "occluderSelector", "name", "ariaLabel", "ref", "sourceSelector", "sourceName", "targetId", "cdpTargetId"] as const) optional(item[key], (value) => typeof value === "string", `${path}/${key}`, "string", issues);
	for (const key of ["role", "sourceRole"] as const) optional(item[key], (value) => value === null || typeof value === "string", `${path}/${key}`, "string or null", issues);
	for (const key of ["clickable", "editable", "disabled", "focused", "checked", "selected", "pressed", "expanded", "visible", "inViewport", "edgeUtility", "hidden", "referenceOnly", "relationOnly"] as const) optional(item[key], (value) => typeof value === "boolean", `${path}/${key}`, "boolean", issues);
	for (const key of ["controlsSelectors", "ownsSelectors", "expandedTargetSelectors", "handlers"] as const) if (item[key] !== undefined) stringArray(item[key], `${path}/${key}`, issues);
	if (item.rect !== undefined) validateRect(item.rect, `${path}/rect`, issues);
	if (item.documentRect !== undefined) validateRect(item.documentRect, `${path}/documentRect`, issues);
	if (item.point !== undefined) validatePoint(item.point, `${path}/point`, issues);
	optional(item.hitOk, (value) => value === null || typeof value === "boolean", `${path}/hitOk`, "boolean or null", issues);
	if (item.hitTarget !== undefined && item.hitTarget !== null) {
		const hit = record(item.hitTarget);
		if (!hit) issues.push(`${path}/hitTarget: expected object or null`);
		else {
			exactKeys(hit, ["tag", "id", "class", "text", "inputLabel"], `${path}/hitTarget`, issues);
			for (const key of ["tag", "id", "class", "text"] as const) stringValue(hit[key], `${path}/hitTarget/${key}`, issues);
			optional(hit.inputLabel, (value) => typeof value === "string", `${path}/hitTarget/inputLabel`, "string", issues);
		}
	}
}

function validateRow(item: Record<string, unknown>, path: string, issues: string[]): void {
	exactKeys(item, ["text", "selector", "rect", "href", "sameOrigin", "containerHint"], path, issues);
	stringValue(item.text, `${path}/text`, issues);
	stringValue(item.selector, `${path}/selector`, issues);
	validateRect(item.rect, `${path}/rect`, issues, true);
	optional(item.href, (value) => typeof value === "string", `${path}/href`, "string", issues);
	optional(item.sameOrigin, (value) => typeof value === "boolean", `${path}/sameOrigin`, "boolean", issues);
	optional(item.containerHint, (value) => typeof value === "string", `${path}/containerHint`, "string", issues);
}

function validateListHint(item: Record<string, unknown>, path: string, issues: string[]): void {
	exactKeys(item, ["selector", "itemCount", "hiddenCount", "firstItemPreview", "sampleHidden", "containerLabel", "containerName", "label", "containerSelector", "heading", "nearestHeading", "landmarkName", "parentLabel"], path, issues);
	stringValue(item.selector, `${path}/selector`, issues);
	finiteNumber(item.itemCount, `${path}/itemCount`, issues);
	finiteNumber(item.hiddenCount, `${path}/hiddenCount`, issues);
	stringValue(item.firstItemPreview, `${path}/firstItemPreview`, issues);
	stringArray(item.sampleHidden, `${path}/sampleHidden`, issues);
	for (const key of ["containerLabel", "containerName", "label", "containerSelector", "heading", "nearestHeading", "landmarkName", "parentLabel"] as const) optional(item[key], (value) => typeof value === "string", `${path}/${key}`, "string", issues);
}

function validateCanvasRegion(item: Record<string, unknown>, path: string, issues: string[]): void {
	exactKeys(item, ["index", "tag", "role", "action", "label", "selector", "point", "rect", "hitOk", "clickable", "text", "visible"], path, issues);
	finiteNumber(item.index, `${path}/index`, issues);
	for (const key of ["tag", "role", "action", "label", "selector"] as const) stringValue(item[key], `${path}/${key}`, issues);
	validatePoint(item.point, `${path}/point`, issues);
	validateRect(item.rect, `${path}/rect`, issues);
	optional(item.hitOk, (value) => value === null || typeof value === "boolean", `${path}/hitOk`, "boolean or null", issues);
	booleanValue(item.clickable, `${path}/clickable`, issues);
	optional(item.text, (value) => typeof value === "string", `${path}/text`, "string", issues);
	optional(item.visible, (value) => typeof value === "boolean", `${path}/visible`, "boolean", issues);
}

function validateMediaCandidate(item: Record<string, unknown>, path: string, issues: string[]): void {
	exactKeys(item, ["index", "tag", "selector", "rect", "src", "poster", "alt", "title", "sameOrigin", "naturalWidth", "naturalHeight", "videoWidth", "videoHeight"], path, issues);
	finiteNumber(item.index, `${path}/index`, issues);
	stringValue(item.tag, `${path}/tag`, issues);
	stringValue(item.selector, `${path}/selector`, issues);
	validateRect(item.rect, `${path}/rect`, issues, true);
	for (const key of ["src", "poster", "alt", "title"] as const) optional(item[key], (value) => typeof value === "string", `${path}/${key}`, "string", issues);
	optional(item.sameOrigin, (value) => typeof value === "boolean", `${path}/sameOrigin`, "boolean", issues);
	for (const key of ["naturalWidth", "naturalHeight", "videoWidth", "videoHeight"] as const) optional(item[key], (value) => typeof value === "number" && Number.isFinite(value), `${path}/${key}`, "finite number", issues);
}

function validateFrameNote(item: Record<string, unknown>, path: string, issues: string[]): void {
	exactKeys(item, ["src", "accessible", "title", "error"], path, issues);
	stringValue(item.src, `${path}/src`, issues);
	booleanValue(item.accessible, `${path}/accessible`, issues);
	optional(item.title, (value) => typeof value === "string", `${path}/title`, "string", issues);
	optional(item.error, (value) => typeof value === "string", `${path}/error`, "string", issues);
}

function validateFingerprint(value: unknown, path: string, issues: string[]): void {
	const item = record(value);
	if (!item) return void issues.push(`${path}: expected object`);
	exactKeys(item, ["changeSeq", "pageEpoch", "documentId", "url", "title", "readyState", "visibleCount", "interactiveCount", "capturedAt"], path, issues);
	finiteNumber(item.changeSeq, `${path}/changeSeq`, issues);
	for (const key of ["pageEpoch", "documentId", "url", "title", "readyState"] as const) optional(item[key], (value) => typeof value === "string", `${path}/${key}`, "string", issues);
	for (const key of ["visibleCount", "interactiveCount", "capturedAt"] as const) optional(item[key], (value) => typeof value === "number" && Number.isFinite(value), `${path}/${key}`, "finite number", issues);
}

function validateGrowthProbe(value: unknown, path: string, issues: string[]): void {
	const item = record(value);
	if (!item) return void issues.push(`${path}: expected object`);
	exactKeys(item, Object.keys(growthProbeProperties), path, issues);
	booleanValue(item.supported, `${path}/supported`, issues);
	finiteNumber(item.candidateCount, `${path}/candidateCount`, issues);
	finiteNumber(item.elapsedMs, `${path}/elapsedMs`, issues);
	for (const key of ["reason", "target", "selector", "beforeFirstText", "afterFirstText"] as const) optional(item[key], (entry) => typeof entry === "string", `${path}/${key}`, "string", issues);
	for (const key of ["beforeCount", "afterCount", "beforeScrollTop", "afterScrollTop", "beforeScrollHeight", "afterScrollHeight", "beforeIntersectingCount", "afterIntersectingCount"] as const) optional(item[key], (entry) => typeof entry === "number" && Number.isFinite(entry), `${path}/${key}`, "finite number", issues);
	for (const key of ["restoredScrollTop", "intersectionSupported", "countGrew", "heightGrew", "windowShifted"] as const) optional(item[key], (entry) => typeof entry === "boolean", `${path}/${key}`, "boolean", issues);
}

export function validatePageWorldScanBundle(value: unknown): ScanBundleValidation {
	const issues: string[] = [];
	const root = record(value);
	if (!root) return { ok: false, issues: ["/: expected object"] };
	exactKeys(root, ["schema", "page", "content", "structure", "frames", "signals", "stats"], "", issues);
	if (root.schema !== PAGE_WORLD_SCAN_SCHEMA) issues.push(`/schema: expected ${PAGE_WORLD_SCAN_SCHEMA}`);

	const page = record(root.page);
	if (!page) issues.push("/page: expected object");
	else {
		exactKeys(page, ["url", "title", "readyState", "language"], "/page", issues);
		for (const key of ["url", "title", "readyState"] as const) stringValue(page[key], `/page/${key}`, issues);
		optional(page.language, (entry) => typeof entry === "string", "/page/language", "string", issues);
	}

	const content = record(root.content);
	if (!content) issues.push("/content: expected object");
	else {
		exactKeys(content, ["text", "tree", "headings", "interactive"], "/content", issues);
		stringValue(content.text, "/content/text", issues);
		optional(content.tree, (entry) => typeof entry === "string", "/content/tree", "string", issues);
		stringArray(content.headings, "/content/headings", issues);
		stringArray(content.interactive, "/content/interactive", issues);
	}

	const structure = record(root.structure);
	if (!structure) issues.push("/structure: expected object");
	else {
		exactKeys(structure, ["actionables", "rows", "listHints", "canvasRegions", "mediaCandidates"], "/structure", issues);
		objectArray(structure.actionables, "/structure/actionables", issues, validateActionable);
		objectArray(structure.rows, "/structure/rows", issues, validateRow);
		objectArray(structure.listHints, "/structure/listHints", issues, validateListHint);
		objectArray(structure.canvasRegions, "/structure/canvasRegions", issues, validateCanvasRegion);
		objectArray(structure.mediaCandidates, "/structure/mediaCandidates", issues, validateMediaCandidate);
	}

	const frames = record(root.frames);
	if (!frames) issues.push("/frames: expected object");
	else {
		exactKeys(frames, ["notes"], "/frames", issues);
		objectArray(frames.notes, "/frames/notes", issues, validateFrameNote);
	}

	const signals = record(root.signals);
	if (!signals) issues.push("/signals: expected object");
	else {
		exactKeys(signals, ["fingerprint", "growthProbe"], "/signals", issues);
		validateFingerprint(signals.fingerprint, "/signals/fingerprint", issues);
		if (signals.growthProbe !== undefined) validateGrowthProbe(signals.growthProbe, "/signals/growthProbe", issues);
	}

	const stats = record(root.stats);
	if (!stats) issues.push("/stats: expected object");
	else {
		exactKeys(stats, ["nodeCount", "outputChars", "truncated"], "/stats", issues);
		finiteNumber(stats.nodeCount, "/stats/nodeCount", issues);
		finiteNumber(stats.outputChars, "/stats/outputChars", issues);
		booleanValue(stats.truncated, "/stats/truncated", issues);
	}

	return issues.length ? { ok: false, issues } : { ok: true, value: value as PageWorldScanBundleV1 };
}
