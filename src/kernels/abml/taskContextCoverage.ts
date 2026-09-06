import type { Entity } from "./entity.js";
import type { TaskEntityIndex } from "./taskViewGraph.js";
import type { TaskEvidence, TaskGap, RequirementKind } from "./taskView.js";
import { addTaskGap, emptyTaskEvidence, REQUIREMENT_KINDS } from "./taskEvidence.js";
import { nativeFormOwner, supplementNativeOwnership } from "./taskOwnership.js";

const OWNERS = new Set(["form", "row", "listitem", "article", "dialog", "alertdialog"]);
const UNCERTAIN_BOUNDARIES = new Set(["group", "region"]);
export type OwnerContextPlan = {
	owner?: Entity;
	refs: Set<string>;
	unknownBoundaries: Set<string>;
	unavailableRefs: Set<string>;
	requiresOwner: boolean;
	nativeOwnerAbsent?: boolean;
};

/** Plan required same-owner fields before ranking. Layout names do not establish ownership. */
export function planOwnerContext(index: TaskEntityIndex, root: Entity, subject = root): OwnerContextPlan {
	const plan: OwnerContextPlan = {
		nativeOwnerAbsent: subject.hints?.formOwnerObserved === true && !subject.hints?.formOwnerSelector,
		refs: new Set(),
		unknownBoundaries: new Set(),
		unavailableRefs: new Set(),
		requiresOwner: OWNERS.has(root.role.toLowerCase()) || UNCERTAIN_BOUNDARIES.has(root.role.toLowerCase()),
	};
	if (OWNERS.has(root.role.toLowerCase())) plan.owner = root;
	const native = nativeFormOwner(index, subject);
	if (!UNCERTAIN_BOUNDARIES.has(root.role.toLowerCase()) && !plan.owner && !native) return plan;
	const chain = new Set<string>([root.ref]);
	let current = root.ref;
	for (let depth = 0; depth < 24 && !plan.owner; depth++) {
		const parent = index.parent.get(current);
		if (!parent || chain.has(parent)) break;
		const owner = index.byRef.get(parent);
		if (!owner) break;
		chain.add(parent);
		current = parent;
		if (OWNERS.has(owner.role.toLowerCase())) {
			plan.owner = owner;
			break;
		}
	}
	if (native && (!plan.owner || plan.owner.role.toLowerCase() === "form")) plan.owner = native;
	if (!plan.owner) return plan;
	chain.add(plan.owner.ref);
	plan.refs = chain;
	const pending = [...(index.children.get(plan.owner.ref) ?? [])];
	const visited = new Set<string>([plan.owner.ref]);
	for (let position = 0; position < pending.length; position++) {
		const ref = pending[position]!;
		if (visited.has(ref) || ref === root.ref) continue;
		visited.add(ref);
		const entity = index.byRef.get(ref);
		if (!entity) {
			plan.unavailableRefs.add(ref);
			continue;
		}
		const role = entity.role.toLowerCase();
		if (OWNERS.has(role) && !chain.has(ref)) continue;
		if (UNCERTAIN_BOUNDARIES.has(role) && !chain.has(ref)) {
			plan.unknownBoundaries.add(ref);
			continue;
		}
		// All captured same-owner fields are candidates, including ordinary cells and text wrappers.
		plan.refs.add(ref);
		pending.push(...(index.children.get(ref) ?? []));
	}
	return supplementNativeOwnership(index, plan);
}

export function assessTaskContext(options: {
	anchor: Entity;
	localRefs: Set<string>;
	candidates: Map<string, Entity>;
	ownerPlan: OwnerContextPlan;
	intent: string;
	focused: boolean;
	issues: Array<Omit<TaskGap, "id" | "remedyIds">>;
}): TaskEvidence {
	const { anchor, localRefs, candidates, ownerPlan, intent } = options;
	const result = emptyTaskEvidence();
	const needsOwner =
		ownerPlan.requiresOwner ||
		anchor.state.editable ||
		!!anchor.actionability?.actions.length ||
		(intent === "interact" && options.focused);
	const actions = [...candidates.values()].filter((entity) => entity.actionability?.actions.length);
	const applicable: Record<RequirementKind, boolean> = {
		local: true,
		owner: !!needsOwner,
		identity: !!needsOwner,
		actions: !!needsOwner && (intent === "interact" || anchor.state.editable),
	};
	const refs = {
		local: [...localRefs],
		owner: ownerPlan.owner ? [ownerPlan.owner.ref] : [],
		identity: [...candidates.keys()],
		actions: [...candidates.keys()],
	};
	for (const kind of REQUIREMENT_KINDS) {
		if (!applicable[kind]) continue;
		const report = result.requirements[kind];
		report.evidence = "complete";
		report.delivery = "inline";
		report.evidenceRefs = refs[kind];
	}
	for (const issue of options.issues) {
		addTaskGap(result, issue);
		// Missing local relations also prevent complete object identification and action context.
		for (const kind of ["local", "identity", "actions"] as const) {
			if (!applicable[kind]) continue;
			if (kind !== issue.requirement) addTaskGap(result, { ...issue, requirement: kind });
			result.requirements[kind].evidence = issue.layer === "capture" ? "incomplete" : "unknown";
		}
	}
	for (const kind of ["owner", "identity", "actions"] as const) {
		if (!applicable[kind]) continue;
		const report = result.requirements[kind];
		if (!ownerPlan.owner || (kind !== "owner" && ownerPlan.unknownBoundaries.size)) {
			report.evidence = "unknown";
			addTaskGap(result, {
				code: `context-${kind}-unknown`,
				requirement: kind,
				layer: "association",
				relatedRefs: ownerPlan.owner ? [...ownerPlan.unknownBoundaries] : [anchor.ref],
				reason: ownerPlan.owner
					? "Captured sibling group/region boundaries have no proven ownership; reading their contents does not prove association."
					: "No captured structural owner establishes this object's context.",
			});
		} else if (kind !== "owner" && ownerPlan.unavailableRefs.size) {
			report.evidence = "incomplete";
			addTaskGap(result, {
				code: "owner-member-unavailable",
				requirement: kind,
				layer: "capture",
				relatedRefs: [...ownerPlan.unavailableRefs],
				reason: "A referenced owner member is absent from the captured model.",
			});
		}
	}
	if (applicable.actions && !actions.length) {
		result.requirements.actions.evidence = "unknown";
		addTaskGap(result, {
			code: "action-presence-unknown",
			requirement: "actions",
			layer: "capture",
			relatedRefs: [anchor.ref],
			reason: "No related actionable control was captured; this does not prove that a separate save control exists or is absent.",
		});
	}
	if (applicable.actions && ownerPlan.nativeOwnerAbsent) {
		result.requirements.actions.evidence = "unknown";
		addTaskGap(result, {
			code: "native-form-owner-absent",
			requirement: "actions",
			layer: "association",
			relatedRefs: [anchor.ref],
			reason: "The native control has no form owner; structural containment alone does not establish its operation's ownership.",
		});
	}
	return result;
}
