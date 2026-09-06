import type { RequirementKind, TaskEvidence, TaskGap, TaskRemedy } from "./taskView.js";

export const REQUIREMENT_KINDS: RequirementKind[] = ["local", "owner", "identity", "actions"];
const REF_LIMIT = 128;

export function emptyTaskEvidence(): TaskEvidence {
	const report = () => ({
		evidence: "not-applicable" as const,
		delivery: "not-applicable" as const,
		reasonCodes: [],
		evidenceRefs: [],
		gapIds: [],
	});
	return {
		requirements: { local: report(), owner: report(), identity: report(), actions: report() },
		gapDetails: [],
		remedies: [],
		gaps: [],
	};
}

/** Gaps are the source of compatibility strings and requirement reason/ID links. */
export function addTaskGap(evidence: TaskEvidence, gap: Omit<TaskGap, "id" | "remedyIds">): void {
	const existing = evidence.gapDetails.find(
		(item) =>
			item.code === gap.code &&
			item.requirement === gap.requirement &&
			item.layer === gap.layer &&
			item.reason === gap.reason,
	);
	if (existing) {
		existing.relatedRefs = [...new Set([...existing.relatedRefs, ...gap.relatedRefs])].slice(0, REF_LIMIT);
		return;
	}
	const id = `gap-${evidence.gapDetails.length + 1}`;
	evidence.gapDetails.push({
		...gap,
		relatedRefs: [...new Set(gap.relatedRefs)].slice(0, REF_LIMIT),
		id,
		remedyIds: [],
	});
	const report = evidence.requirements[gap.requirement];
	if (!report.reasonCodes.includes(gap.code)) report.reasonCodes.push(gap.code);
	report.gapIds.push(id);
	if (!evidence.gaps.includes(gap.code)) evidence.gaps.push(gap.code);
}

export function retainTaskEvidence(evidence: TaskEvidence, selected: Set<string>): void {
	for (const kind of REQUIREMENT_KINDS) {
		const report = evidence.requirements[kind];
		if (report.evidence === "not-applicable") continue;
		const missing = report.evidenceRefs.filter((ref) => !selected.has(ref));
		if (missing.length) {
			addTaskGap(evidence, {
				code: "context-selection-limit",
				requirement: kind,
				layer: "selection",
				relatedRefs: missing,
				reason: "Captured evidence was not retained in this materialized group; reading the group cannot restore it.",
			});
		}
		if (report.evidenceRefs.length > REF_LIMIT) {
			addTaskGap(evidence, {
				code: "evidence-reference-limit",
				requirement: kind,
				layer: "selection",
				relatedRefs: [],
				reason: "The evidence reference list is bounded; the canonical snapshot contains the remaining references.",
			});
			report.evidenceRefs = [...report.evidenceRefs.filter((ref) => selected.has(ref)), ...missing].slice(
				0,
				REF_LIMIT,
			);
		}
		report.delivery = report.evidenceRefs.some((ref) => selected.has(ref)) ? "partial" : "unavailable";
		if (report.evidence === "complete" && !report.gapIds.length) report.delivery = "inline";
	}
}

/** Bind IDs and only offer reads that have a registered immutable snapshot resource. */
export function bindTaskRemedies(evidence: TaskEvidence, id: string, canonicalUri?: string): void {
	const ids = new Map(evidence.gapDetails.map((gap, i) => [gap.id, `${id}-gap-${i + 1}`]));
	for (const kind of REQUIREMENT_KINDS)
		evidence.requirements[kind].gapIds = evidence.requirements[kind].gapIds.map((gapId) => ids.get(gapId)!);
	evidence.remedies = [];
	for (const gap of evidence.gapDetails) {
		gap.id = ids.get(gap.id)!;
		const remedyId = `${gap.id}-remedy`;
		let remedy: TaskRemedy | undefined;
		if (gap.layer === "capture" || gap.layer === "freshness") {
			remedy = { id: remedyId, kind: "observe-again", changesSnapshot: true, reason: gap.reason };
		} else if (gap.layer === "association") {
			remedy = { id: remedyId, kind: "disambiguate", candidateRefs: gap.relatedRefs, reason: gap.reason };
		} else if (gap.layer === "selection" && canonicalUri) {
			remedy = { id: remedyId, kind: "read-snapshot", resourceUri: canonicalUri, mayAddress: [gap.id] };
		}
		gap.remedyIds = remedy ? [remedy.id] : [];
		if (remedy) evidence.remedies.push(remedy);
		if (gap.layer === "association" && canonicalUri && gap.relatedRefs.length) {
			const read = {
				id: `${gap.id}-inspect`,
				kind: "read-snapshot" as const,
				resourceUri: canonicalUri,
				mayAddress: [gap.id],
			};
			gap.remedyIds.push(read.id);
			evidence.remedies.push(read);
		}
	}
}

/** An index describes folded evidence; reading it never repairs capture or association gaps. */
export function foldedTaskEvidence(evidence: TaskEvidence, id: string, resourceUri: string): TaskEvidence {
	const copy: TaskEvidence = JSON.parse(
		JSON.stringify({
			requirements: evidence.requirements,
			gapDetails: evidence.gapDetails,
			remedies: evidence.remedies,
			gaps: evidence.gaps,
		}),
	);
	for (const kind of REQUIREMENT_KINDS) {
		const report = copy.requirements[kind];
		if (report.delivery === "not-applicable" || report.delivery === "unavailable") continue;
		const gapId = `${id}-delivery-${kind}`;
		const code = `context-${kind}-folded`;
		copy.gapDetails.push({
			id: gapId,
			code,
			requirement: kind,
			layer: "delivery",
			relatedRefs: report.evidenceRefs,
			reason: "This index does not include the group's saved facts. Reading them does not establish missing relationships.",
			remedyIds: [`${id}-read`],
		});
		report.gapIds.push(gapId);
		report.reasonCodes.push(code);
		report.delivery = "folded";
		copy.gaps.push(code);
	}
	const mayAddress = copy.gapDetails.filter((gap) => gap.layer === "delivery").map((gap) => gap.id);
	if (mayAddress.length) copy.remedies.push({ id: `${id}-read`, kind: "read-snapshot", resourceUri, mayAddress });
	return copy;
}
