import { TASK_PROJECTION_POLICY, TASK_PROJECTION_SCHEMA } from "./taskView.js";

const text = { type: "string" } as const;
const count = { type: "integer", minimum: 0 } as const;
const flag = { type: "boolean" } as const;
const strings = { type: "array", items: text } as const;
const focus = {
	anyOf: [
		{
			type: "object",
			properties: {
				refs: {
					type: "array",
					minItems: 1,
					maxItems: 8,
					items: { type: "string", pattern: "^bp-ref://", maxLength: 512 },
				},
			},
			required: ["refs"],
			additionalProperties: false,
		},
		{
			type: "object",
			properties: { query: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" } },
			required: ["query"],
			additionalProperties: false,
		},
	],
} as const;
const intent = { enum: ["locate", "read", "interact", "check"] } as const;
const fields = {
	type: "array",
	maxItems: 16,
	items: { type: "string", minLength: 1, maxLength: 64, pattern: "\\S" },
} as const;
const spec = {
	type: "object",
	properties: { focus, intent, fields },
	required: ["focus", "intent", "fields"],
	additionalProperties: false,
} as const;

const LEGACY_TASK_BUNDLE_SCHEMA = {
	type: "object",
	properties: {
		id: text,
		kind: { enum: ["record", "field", "dialog", "feedback", "context", "content"] },
		anchor: { type: "object", properties: { ref: text, role: text, name: text }, additionalProperties: false },
		candidate: flag,
		mandatory: flag,
		reasons: strings,
		gaps: strings,
		text,
		facts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					ref: text,
					role: text,
					name: text,
					value: text,
					text,
					textSource: { const: "ax" },
					source: { enum: ["dom", "ax", "vision"] },
					actions: { type: "array", items: { enum: ["click", "edit"] } },
					state: {
						type: "object",
						properties: {
							visible: flag,
							occluded: flag,
							disabled: flag,
							focused: flag,
							editable: flag,
							inViewport: flag,
							checked: flag,
							selected: flag,
							pressed: flag,
							expanded: flag,
							current: { anyOf: [flag, text] },
						},
						required: ["visible", "occluded", "disabled", "focused", "editable", "inViewport"],
						additionalProperties: false,
					},
				},
				required: ["ref", "role", "state", "source"],
				additionalProperties: false,
			},
		},
		matches: {
			type: "array",
			items: {
				type: "object",
				properties: {
					ref: text,
					field: { enum: ["name", "value", "label", "content"] },
					text,
					kind: { enum: ["exact", "contains"] },
				},
				required: ["field", "text", "kind"],
				additionalProperties: false,
			},
		},
		changes: {
			type: "array",
			items: {
				type: "object",
				properties: { ref: text, kind: text, fields: strings },
				required: ["ref", "kind", "fields"],
				additionalProperties: false,
			},
		},
	},
	required: ["id", "kind", "anchor", "candidate", "mandatory", "reasons", "facts", "matches", "gaps", "changes"],
	additionalProperties: false,
} as const;

const requirement = { enum: ["local", "owner", "identity", "actions"] } as const;
const report = {
	type: "object",
	properties: {
		evidence: { enum: ["complete", "incomplete", "unknown", "not-applicable"] },
		delivery: { enum: ["inline", "partial", "folded", "unavailable", "not-applicable"] },
		reasonCodes: strings,
		evidenceRefs: strings,
		gapIds: strings,
	},
	required: ["evidence", "delivery", "reasonCodes", "evidenceRefs", "gapIds"],
	additionalProperties: false,
} as const;
export const TASK_BUNDLE_SCHEMA = {
	...LEGACY_TASK_BUNDLE_SCHEMA,
	properties: {
		...LEGACY_TASK_BUNDLE_SCHEMA.properties,
		requirements: {
			type: "object",
			properties: { local: report, owner: report, identity: report, actions: report },
			required: ["local", "owner", "identity", "actions"],
			additionalProperties: false,
		},
		gapDetails: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: text,
					code: text,
					requirement,
					layer: { enum: ["delivery", "selection", "capture", "association", "freshness"] },
					relatedRefs: strings,
					reason: text,
					remedyIds: strings,
				},
				required: ["id", "code", "requirement", "layer", "relatedRefs", "reason", "remedyIds"],
				additionalProperties: false,
			},
		},
		remedies: {
			type: "array",
			items: {
				anyOf: [
					{
						type: "object",
						properties: {
							id: text,
							kind: { const: "read-snapshot" },
							resourceUri: text,
							mayAddress: strings,
							resourceJsonBytes: count,
						},
						required: ["id", "kind", "resourceUri", "mayAddress"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							id: text,
							kind: { const: "observe-again" },
							reason: text,
							changesSnapshot: { const: true },
						},
						required: ["id", "kind", "reason", "changesSnapshot"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: { id: text, kind: { const: "disambiguate" }, candidateRefs: strings, reason: text },
						required: ["id", "kind", "candidateRefs", "reason"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							id: text,
							kind: { const: "page-action-required" },
							relatedRefs: strings,
							reason: text,
						},
						required: ["id", "kind", "relatedRefs", "reason"],
						additionalProperties: false,
					},
				],
			},
		},
	},
	required: [...LEGACY_TASK_BUNDLE_SCHEMA.required, "requirements", "gapDetails", "remedies"],
} as const;

export const TASK_VIEW_METADATA_SCHEMA = {
	type: "object",
	properties: {
		intent,
		focus,
		fields,
		status: { enum: ["resolved", "ambiguous", "no-match-in-observed", "unresolved"] },
		unresolvedRefs: strings,
		observationScope: {
			type: "object",
			properties: {
				entitiesObserved: count,
				contentComplete: flag,
				actionsComplete: flag,
				selectionComplete: flag,
				collectionCount: count,
				partialCollectionCount: count,
				collections: {
					type: "array",
					items: {
						type: "object",
						properties: { ref: text, name: text, observed: count, total: count, completeness: text },
						required: ["ref", "observed", "completeness"],
						additionalProperties: false,
					},
				},
			},
			required: [
				"entitiesObserved",
				"contentComplete",
				"actionsComplete",
				"selectionComplete",
				"collectionCount",
				"partialCollectionCount",
				"collections",
			],
			additionalProperties: false,
		},
		matchScope: {
			type: "object",
			properties: {
				method: { enum: ["explicit-refs", "literal-case-insensitive"] },
				unit: { const: "structural-object-or-entity" },
				candidateCount: count,
				contentMatchCount: count,
				searched: strings,
				complete: flag,
			},
			required: ["method", "unit", "candidateCount", "contentMatchCount", "searched", "complete"],
			additionalProperties: false,
		},
		outputScope: {
			type: "object",
			properties: {
				groupsTotal: count,
				groupsInline: count,
				groupsFolded: count,
				groupsUnavailable: count,
				mandatoryGroups: count,
				mandatoryGroupsFolded: count,
				mandatoryGroupsUnavailable: count,
				contextComplete: flag,
			},
			required: [
				"groupsTotal",
				"groupsInline",
				"groupsFolded",
				"mandatoryGroups",
				"mandatoryGroupsFolded",
				"contextComplete",
			],
			additionalProperties: false,
		},
		limitations: strings,
	},
	required: [
		"intent",
		"focus",
		"fields",
		"status",
		"unresolvedRefs",
		"observationScope",
		"matchScope",
		"outputScope",
		"limitations",
	],
	additionalProperties: false,
} as const;

export const TASK_PROJECTION_ARTIFACT_SCHEMA = {
	type: "object",
	properties: {
		schema: { const: TASK_PROJECTION_SCHEMA },
		policy: { const: TASK_PROJECTION_POLICY },
		snapshotId: text,
		canonicalSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
		capturedAt: { type: "number" },
		expiresAt: { type: "number" },
		spec,
		task: TASK_VIEW_METADATA_SCHEMA,
		bundles: { type: "array", items: TASK_BUNDLE_SCHEMA },
	},
	required: [
		"schema",
		"policy",
		"snapshotId",
		"canonicalSha256",
		"capturedAt",
		"expiresAt",
		"spec",
		"task",
		"bundles",
	],
	additionalProperties: false,
} as const;

export const LEGACY_TASK_PROJECTION_ARTIFACT_SCHEMA = {
	...TASK_PROJECTION_ARTIFACT_SCHEMA,
	properties: {
		...TASK_PROJECTION_ARTIFACT_SCHEMA.properties,
		schema: { const: "browser-task-projection/v1" },
		policy: { const: "literal-context-v1" },
		bundles: { type: "array", items: LEGACY_TASK_BUNDLE_SCHEMA },
	},
} as const;
