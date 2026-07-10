import { extractRefsFromText } from "../kernels/refs/text.js";
import type { DistilledSummary } from "./resultTypes.js";
import { asArray, isRecord } from "./summaries/common.js";

type NextActionsOptions = {
	browserSessionId?: string;
};

function artifactReadActions(summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>): string[] {
	if (!saved?.path) return [];
	const hints = isRecord(summary.artifact_hints) ? summary.artifact_hints : undefined;
	const preferredReads = asArray(hints?.preferredReads).filter(isRecord);
	const actions = preferredReads
		.map((hint) => typeof hint.jsonPath === "string" && hint.jsonPath ? `read_saved_artifact mode=json jsonPath=${hint.jsonPath}` : undefined)
		.filter((item): item is string => !!item)
		.slice(0, 3);
	const dataAlreadyInline = summary.dataInline === true;
	if (!dataAlreadyInline) {
		const correlationPaths = [
			{ key: "operationId", path: "operation.operationId", value: operation?.operationId },
			{ key: "snapshotId", path: "snapshot.snapshotId", value: snapshot?.snapshotId },
			{ key: "requestId", path: "data.requestId", value: summary.requestId },
			{ key: "waitId", path: "data.waitId", value: summary.waitId },
			{ key: "listenerId", path: "data.listenerId", value: summary.listenerId },
		].filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
		for (const item of correlationPaths.slice(0, 3)) actions.push(`read_saved_artifact mode=json jsonPath=${item.path}`);
	}
	return actions.length ? Array.from(new Set(actions)) : ["read_saved_artifact mode=json", "read_saved_artifact mode=text"];
}

const SESSION_DELTA_RECOVERY_TARGET_LIMIT = 3;

function recoveryTargetKey(action: string): string | undefined {
	if (action.startsWith("read_saved_artifact")) return action;
	const ref = extractRefsFromText(action)[0];
	return ref;
}

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

export function normalizedNextActions(options: NextActionsOptions, summary: DistilledSummary, saved?: Record<string, unknown>, operation?: Record<string, unknown>, snapshot?: Record<string, unknown>, summaryHintActions: string[] = [], entities?: Array<Record<string, unknown>>): string[] | undefined {
	const actions: string[] = [];
	actions.push(...summaryHintActions.filter((item) => !item.includes("path=")));
	actions.push(...artifactReadActions(summary, saved, operation, snapshot));
	if (entities?.length) {
		const first = entities.find((entity) => typeof entity.ref === "string") || entities[0];
		const ref = typeof first?.ref === "string" ? first.ref : undefined;
		const kind = typeof first?.kind === "string" ? first.kind : undefined;
		if (ref) {
			actions.push(`read(${ref})`);
			if (kind === "control" || kind === "element") actions.push(`click(${ref})`);
			if (kind === "region") actions.push(`inspect(${ref})`);
			if (kind === "frame") actions.push(`frame(${ref})`);
		}
	}
	if (saved?.path && summary.nextOffset !== undefined && summary.nextOffset !== null) actions.push(`read_saved_artifact offset=${String(summary.nextOffset)}`);
	if (summary.bodyUnavailableReason) actions.push("inspect network body with a fresh recorder entry or recapture with captureBodies enabled");
	if (summary.notFound === true && typeof summary.nearestPath === "string" && summary.nearestPath) actions.push(`read_saved_artifact mode=json jsonPath=${summary.nearestPath}`);
	if (summary.empty === true || summary.notFound === true) actions.push("narrow the target ref/filter or re-run browser_observe; for exact DOM inspection use explicit legacy/debug projection browser_observe mode=html");
	if (summary.truncated === true || summary.bodyTruncated === true || summary.truncatedCases === true || summary.truncatedCandidates) actions.push("increase maxChars/maxBodyBytes or inspect the saved artifact by jsonPath/offset");
	if (options.browserSessionId === undefined && (summary.tabId !== undefined || summary.targetRef !== undefined || isRecord(summary.target))) actions.push("pass explicit targetRef/browserSessionId for follow-up tab-scoped calls");
	const unique = capSessionDeltaRecoveryFanout(Array.from(new Set(actions)), typeof summary.delta === "string" ? summary.delta : undefined);
	return unique.length ? unique.slice(0, 7) : undefined;
}
