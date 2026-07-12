import { extractRefsFromText } from "../kernels/refs/text.js";
import type { DistilledSummary } from "./resultTypes.js";
import { asArray, isRecord } from "./summaries/common.js";

type NextActionsOptions = { browserSessionId?: string };

function artifactFollowUpRequired(summary: DistilledSummary): boolean {
	return summary.dataInline === false
		|| summary.fullResult === "saved_to_artifact"
		|| summary.truncated === true
		|| summary.bodyTruncated === true
		|| summary.truncatedCases === true
		|| Boolean(summary.truncatedCandidates)
		|| asArray(summary.summaryOmitted).length > 0
		|| asArray(summary.rendererOmitted).length > 0
		|| asArray(summary.envelopeOmitted).length > 0;
}

function artifactReadActions(summary: DistilledSummary, saved?: Record<string, unknown>, artifactHints?: Record<string, unknown>): string[] {
	if (!saved?.path || !artifactFollowUpRequired(summary)) return [];
	const preferredReads = asArray(artifactHints?.preferredReads).filter(isRecord);
	return Array.from(new Set(preferredReads
		.map((hint) => typeof hint.jsonPath === "string" && hint.jsonPath ? `read_saved_artifact mode=json jsonPath=${hint.jsonPath}` : undefined)
		.filter((item): item is string => !!item)))
		.slice(0, 3);
}

function verifiedArtifactJsonPaths(artifactHints?: Record<string, unknown>): Set<string> {
	const jsonPaths = isRecord(artifactHints?.jsonPaths)
		? Object.values(artifactHints.jsonPaths).filter((value): value is string => typeof value === "string" && value.length > 0)
		: [];
	const preferred = asArray(artifactHints?.preferredReads)
		.filter(isRecord)
		.flatMap((hint) => typeof hint.jsonPath === "string" && hint.jsonPath ? [hint.jsonPath] : []);
	return new Set([...jsonPaths, ...preferred]);
}

const SESSION_DELTA_RECOVERY_TARGET_LIMIT = 3;

function recoveryTargetKey(action: string): string | undefined { return action.startsWith("read_saved_artifact") ? action : extractRefsFromText(action)[0]; }

function capSessionDeltaRecoveryFanout(actions: string[], delta?: string): string[] {
	if (delta !== "session") return actions;
	const seenTargets = new Set<string>();
	return actions.filter((action) => {
		const key = recoveryTargetKey(action);
		if (!key) return true;
		if (seenTargets.has(key)) return true;
		if (seenTargets.size >= SESSION_DELTA_RECOVERY_TARGET_LIMIT) return false;
		seenTargets.add(key);
		return true;
	});
}

const RETIRED_ENTITY_PSEUDO_ACTION = /^(?:read|click|inspect|frame)\(\s*bp-ref:\/\//i;

function usableSummaryHint(action: string, saved: Record<string, unknown> | undefined, verifiedPaths: Set<string>): boolean {
	if (action.includes("path=") || RETIRED_ENTITY_PSEUDO_ACTION.test(action.trim())) return false;
	if (!action.startsWith("read_saved_artifact")) return true;
	if (!saved?.path) return false;
	const jsonPath = action.match(/\bjsonPath=([^\s]+)/)?.[1];
	return jsonPath ? verifiedPaths.has(jsonPath) : !/\bmode=json\b/.test(action);
}

function needsExplicitTarget(options: NextActionsOptions, summary: DistilledSummary): boolean {
	return options.browserSessionId === undefined && (summary.tabId !== undefined || summary.targetRef !== undefined || isRecord(summary.target));
}

function savedProgressActions(summary: DistilledSummary, saved: Record<string, unknown> | undefined, verifiedPaths: Set<string>): string[] {
	const actions: string[] = [];
	if (saved?.path && summary.nextOffset !== undefined && summary.nextOffset !== null) actions.push(`read_saved_artifact offset=${String(summary.nextOffset)}`);
	if (saved?.path && summary.notFound === true && typeof summary.nearestPath === "string" && verifiedPaths.has(summary.nearestPath)) actions.push(`read_saved_artifact mode=json jsonPath=${summary.nearestPath}`);
	return actions;
}

function summaryTruncated(summary: DistilledSummary): boolean {
	return summary.truncated === true || summary.bodyTruncated === true || summary.truncatedCases === true || Boolean(summary.truncatedCandidates);
}

function summaryRecoveryActions(options: NextActionsOptions, summary: DistilledSummary): string[] {
	const actions: string[] = [];
	if (summary.bodyUnavailableReason) actions.push("inspect network body with a fresh recorder entry or recapture with captureBodies enabled");
	if (summary.empty === true || summary.notFound === true) actions.push("narrow the target ref/filter or re-run browser_observe; for exact DOM inspection use explicit legacy/debug projection browser_observe mode=html");
	if (summaryTruncated(summary)) actions.push("increase maxChars/maxBodyBytes or inspect the saved artifact by jsonPath/offset");
	if (needsExplicitTarget(options, summary)) actions.push("pass explicit targetRef/browserSessionId for follow-up tab-scoped calls");
	return actions;
}

export function normalizedNextActions(options: NextActionsOptions, summary: DistilledSummary, saved?: Record<string, unknown>, artifactHints?: Record<string, unknown>, summaryHintActions: string[] = []): string[] | undefined {
	const actions: string[] = [];
	const verifiedPaths = verifiedArtifactJsonPaths(artifactHints);
	actions.push(...summaryHintActions.filter((action) => usableSummaryHint(action, saved, verifiedPaths)));
	actions.push(...artifactReadActions(summary, saved, artifactHints));
	actions.push(...savedProgressActions(summary, saved, verifiedPaths));
	actions.push(...summaryRecoveryActions(options, summary));
	const unique = capSessionDeltaRecoveryFanout(Array.from(new Set(actions)), typeof summary.delta === "string" ? summary.delta : undefined);
	return unique.length ? unique.slice(0, 7) : undefined;
}
