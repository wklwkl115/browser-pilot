export const PAGE_WORLD_SCAN_SCHEMA = "browser-page-scan/v1" as const;

export interface ScanRect {
	x: number;
	y: number;
	width: number;
	height: number;
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
	actionConfidence?: "high" | "medium";
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
	scope?: { key: string; name?: string; position: number; size: number };
}

export interface ScanListHint {
	selector: string;
	itemCount: number;
	firstItemPreview: string;
	containerLabel?: string;
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
	content: { text: string; headings: string[] };
	structure: {
		actionables: ScanActionable[];
		listHints: ScanListHint[];
		canvasRegions: ScanCanvasRegion[];
	};
	signals: { fingerprint: ScanPageFingerprint };
	stats: { nodeCount: number; outputChars: number; truncated: boolean; actionableCount?: number; actionablesComplete?: boolean };
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
const hitTargetSchema = {
	type: "object",
	properties: { tag: stringSchema, id: stringSchema, class: stringSchema, text: stringSchema, inputLabel: stringSchema },
	required: ["tag", "id", "class", "text"],
	additionalProperties: false,
} as const;

const actionableProperties = {
	index: numberSchema, selector: stringSchema, tag: stringSchema, kind: stringSchema, role: nullableStringSchema, action: stringSchema,
	label: stringSchema, displayLabel: stringSchema, text: stringSchema, value: stringSchema, clickable: booleanSchema, editable: booleanSchema, actionConfidence: { enum: ["high", "medium"] },
	disabled: booleanSchema, focused: booleanSchema, checked: booleanSchema, selected: booleanSchema, pressed: booleanSchema,
	expanded: booleanSchema, visible: booleanSchema, inViewport: booleanSchema, current: stringSchema, inputKind: stringSchema,
	controlsSelectors: stringArraySchema, ownsSelectors: stringArraySchema, expandedTargetSelectors: stringArraySchema,
	position: stringSchema, edgeUtility: booleanSchema, handlers: stringArraySchema, rect: rectSchema, documentRect: rectSchema,
	point: pointSchema, hitOk: nullableBooleanSchema, hitTarget: { anyOf: [hitTargetSchema, { type: "null" }] }, href: stringSchema,
	occluderSelector: stringSchema, priority: numberSchema, name: stringSchema, ariaLabel: stringSchema, ref: stringSchema, hidden: booleanSchema, referenceOnly: booleanSchema,
	relationOnly: booleanSchema, sourceSelector: stringSchema, sourceRole: nullableStringSchema, sourceName: stringSchema,
	targetId: stringSchema, cdpTargetId: stringSchema,
	scope: { type: "object", properties: { key: stringSchema, name: stringSchema, position: numberSchema, size: numberSchema }, required: ["key", "position", "size"], additionalProperties: false },
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
			properties: { text: stringSchema, headings: stringArraySchema },
			required: ["text", "headings"],
			additionalProperties: false,
		},
		structure: {
			type: "object",
			properties: {
				actionables: { type: "array", items: { type: "object", properties: actionableProperties, anyOf: [{ required: ["selector"] }, { required: ["sourceSelector"] }], additionalProperties: false } },
				listHints: { type: "array", items: { type: "object", properties: { selector: stringSchema, itemCount: numberSchema, firstItemPreview: stringSchema, containerLabel: stringSchema }, required: ["selector", "itemCount", "firstItemPreview"], additionalProperties: false } },
				canvasRegions: { type: "array", items: { type: "object", properties: { index: numberSchema, tag: stringSchema, role: stringSchema, action: stringSchema, label: stringSchema, selector: stringSchema, point: pointSchema, rect: rectSchema, hitOk: nullableBooleanSchema, clickable: booleanSchema, text: stringSchema, visible: booleanSchema }, required: ["index", "tag", "role", "action", "label", "selector", "point", "rect", "hitOk", "clickable"], additionalProperties: false } },
			},
			required: ["actionables", "listHints", "canvasRegions"],
			additionalProperties: false,
		},
		signals: {
			type: "object",
			properties: {
				fingerprint: { type: "object", properties: { changeSeq: numberSchema, pageEpoch: stringSchema, documentId: stringSchema, url: stringSchema, title: stringSchema, readyState: stringSchema, visibleCount: numberSchema, interactiveCount: numberSchema, capturedAt: numberSchema }, required: ["changeSeq"], additionalProperties: false },
			},
			required: ["fingerprint"],
			additionalProperties: false,
		},
		stats: { type: "object", properties: { nodeCount: numberSchema, outputChars: numberSchema, truncated: booleanSchema, actionableCount: numberSchema, actionablesComplete: booleanSchema }, required: ["nodeCount", "outputChars", "truncated"], additionalProperties: false },
	},
	required: ["schema", "page", "content", "structure", "signals", "stats"],
	additionalProperties: false,
} as const;
