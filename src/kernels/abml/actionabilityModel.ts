import type { ActionabilityBlockerCode, ActionabilityPredicate, ActionabilityReport, ActionabilitySpec } from "./types.js";

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

// ── Actionability diagnostics (pure) ────────────────────────────────────────────────

const BLOCKER_CODE_TO_PREDICATE: Record<ActionabilityBlockerCode, ActionabilityPredicate> = {
	not_unique: "unique",
	detached: "attached",
	not_visible: "visible",
	not_stable: "stable",
	disabled: "enabled",
	not_editable: "editable",
	outside_viewport: "inViewport",
	not_scrollable: "scrollable",
	not_receiving_events: "receivesEvents",
	occluded: "notOccluded",
};

const BLOCKER_CODE_TO_REASON: Record<ActionabilityBlockerCode, string> = {
	not_unique: "element is not uniquely identified",
	detached: "element is detached from the DOM",
	not_visible: "element is not visible",
	not_stable: "element position is not stable",
	disabled: "element is disabled",
	not_editable: "element is not editable",
	outside_viewport: "element is outside the viewport",
	not_scrollable: "element is not scrollable",
	not_receiving_events: "element does not receive pointer events",
	occluded: "element is occluded by another element",
};

/**
 * Extract the predicate names that failed from an ActionabilityReport.
 * Returns the predicates in the order they appear in the report's blockers array.
 */
export function failedChecksFromReport(report: ActionabilityReport): ActionabilityPredicate[] {
	const seen = new Set<ActionabilityPredicate>();
	const result: ActionabilityPredicate[] = [];

	// Primary source: explicit blockers carry the authoritative failure list.
	for (const blocker of report.blockers) {
		const predicate = BLOCKER_CODE_TO_PREDICATE[blocker.code];
		if (predicate && !seen.has(predicate)) {
			seen.add(predicate);
			result.push(predicate);
		}
	}

	// Secondary source: the checks map may record failures not yet in blockers
	// (e.g. a partial poll that timed out before surfacing all blocker entries).
	if (report.checks) {
		for (const [predicate, passed] of Object.entries(report.checks) as Array<[ActionabilityPredicate, boolean]>) {
			if (passed === false && !seen.has(predicate)) {
				seen.add(predicate);
				result.push(predicate);
			}
		}
	}

	return result;
}

/**
 * Build a human-readable reason string from an ActionabilityReport's blockers.
 * Returns undefined when the report has no blockers (i.e. `report.ok === true`).
 */
export function actionabilityFailureReason(report: ActionabilityReport): string | undefined {
	if (!report.blockers.length) return undefined;
	const reasons: string[] = [];
	const seen = new Set<ActionabilityBlockerCode>();
	for (const blocker of report.blockers) {
		if (seen.has(blocker.code)) continue;
		seen.add(blocker.code);
		reasons.push(blocker.message || BLOCKER_CODE_TO_REASON[blocker.code] || blocker.code);
	}
	return reasons.join("; ");
}
