import type { ActionabilityPredicate, ActionabilitySpec } from "./types.js";

export const ACTION_TIMEOUT_MS = 5000;
export const ACTION_POLL_MS = 100;
export const STABLE_WINDOW_MS = 150;
export const STABLE_EPSILON_PX = 1;

const DEFAULT_ACTIONABILITY_BASE = {
	timeoutMs: ACTION_TIMEOUT_MS,
	pollMs: ACTION_POLL_MS,
	stableWindowMs: STABLE_WINDOW_MS,
	stableEpsilonPx: STABLE_EPSILON_PX,
} as const;

export const ACTIONABILITY_VERB_MATRIX = {
	click: ["unique", "attached", "visible", "stable", "enabled", "inViewport", "receivesEvents", "notOccluded"],
	type: ["unique", "attached", "visible", "stable", "enabled", "editable", "inViewport"],
	select: ["unique", "attached", "visible", "stable", "enabled", "inViewport"],
	hover: ["unique", "attached", "visible", "stable", "inViewport", "receivesEvents"],
	drag: ["unique", "attached", "visible", "stable", "inViewport", "receivesEvents"],
	scroll: ["attached", "scrollable"],
	upload: ["unique", "attached", "enabled"],
} as const satisfies Record<string, ActionabilityPredicate[]>;

export type AbmlActionVerb = keyof typeof ACTIONABILITY_VERB_MATRIX;

export function actionabilitySpecForVerb(verb: AbmlActionVerb): ActionabilitySpec {
	return {
		...DEFAULT_ACTIONABILITY_BASE,
		required: [...ACTIONABILITY_VERB_MATRIX[verb]],
	};
}

export function isActionVerb(value: string): value is AbmlActionVerb {
	return Object.hasOwn(ACTIONABILITY_VERB_MATRIX, value);
}
