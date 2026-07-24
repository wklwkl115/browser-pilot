export type RefLocator =
	| { by: "backendNodeId"; value: number; targetId?: string }
	| { by: "axNodeId"; value: string }
	| { by: "attrSignature"; value: Record<string, string> }
	| { by: "css"; value: string }
	| { by: "xpath"; value: string }
	| { by: "textAnchor"; value: string; role?: string; exact?: boolean }
	| { by: "point"; x: number; y: number };

export type RefKind =
	| "element"
	| "control"
	| "text"
	| "media"
	| "ax"
	| "region"
	| "frame"
	| "network-entry"
	| "event"
	| "signal"
	| "data-slice";

export type RefOwner = {
	browserSessionId?: string;
	tabId?: number;
	frameRef?: string;
	targetId?: string;
	topLevelOrigin?: string;
};

export type RefPolicy = {
	redaction: "default" | "disabled";
	shareableAcrossSessions: boolean;
	liveActionsAllowed: boolean;
};

export type RefSnapshotBinding = {
	observationId: string;
	resourceUri?: string;
	jsonPath?: string;
	etag?: string;
	immutable: boolean;
};

export type RefDocumentEpoch = {
	frameId?: string;
	loaderId?: string;
	navigationId?: string;
	targetGeneration?: number;
	pageEpoch?: string;
	url?: string;
	mutationEpoch?: number;
	changeSeq?: number;
	documentId?: string;
	capturedAt: number;
};

export type RefVisualBinding = {
	resourceUri: string;
	sha256: string;
	width: number;
	height: number;
	captureMethod: string;
	actionableGrounding: boolean;
	fingerprint: {
		changeSeq: number;
		pageEpoch?: string;
		documentId?: string;
		url?: string;
		scrollX: number;
		scrollY: number;
		viewportWidth: number;
		viewportHeight: number;
		devicePixelRatio: number;
	};
	imageToCss: [number, number, number, number, number, number];
	anchor?: {
		hostRef: string;
		point: { x: number; y: number };
		to?: { x: number; y: number };
	};
};

export type RefSemanticState = Record<string, boolean>;

export type RefGeometry = {
	/** Viewport-relative CSS pixels. */
	box?: { x: number; y: number; w: number; h: number };
	point?: { x: number; y: number };
};

export type RefDescriptor = {
	refId: string;
	kind: RefKind;
	locators: RefLocator[];
	owner: RefOwner;
	policy: RefPolicy;
	snapshot?: RefSnapshotBinding;
	visual?: RefVisualBinding;
	semantic?: {
		role?: string;
		name?: string;
		value?: string;
		state?: RefSemanticState;
		anchor?: {
			scope: "abml-template";
			confidence: "high" | "low";
			mintingEligible?: boolean;
			containerRole?: string;
			containerName?: string;
			setSize?: number;
			role?: string;
			kind?: string;
			name?: string;
			normalizedName?: string;
			posInSet?: number;
		};
	};
	geometry?: RefGeometry;
	observationId: string;
	documentEpoch?: RefDocumentEpoch;
	createdAt: number;
	ttlMs: number;
	stabilityScore?: number;
};
