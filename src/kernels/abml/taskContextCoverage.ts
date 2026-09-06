import type { Entity } from "./entity.js";
import type { TaskEntityIndex } from "./taskViewGraph.js";

const OWNERS = new Set(["form", "row", "listitem", "article", "dialog", "alertdialog"]);
const UNCERTAIN_BOUNDARIES = new Set(["group", "region"]);
type Coverage = "complete" | "incomplete" | "unknown" | "not-applicable";
export type TaskContextRequirements = Record<"local" | "owner" | "identity" | "actions", Coverage>;
export type OwnerContextPlan = {
	owner?: Entity;
	refs: Set<string>;
	unknownBoundaries: Set<string>;
	unavailable: boolean;
	requiresOwner: boolean;
};

/** Plan required same-owner fields before ranking. Layout names do not establish ownership. */
export function planOwnerContext(index: TaskEntityIndex, root: Entity): OwnerContextPlan {
	const plan: OwnerContextPlan = {
		refs: new Set(),
		unknownBoundaries: new Set(),
		unavailable: false,
		requiresOwner: OWNERS.has(root.role.toLowerCase()) || UNCERTAIN_BOUNDARIES.has(root.role.toLowerCase()),
	};
	if (OWNERS.has(root.role.toLowerCase())) return { ...plan, owner: root };
	if (!UNCERTAIN_BOUNDARIES.has(root.role.toLowerCase())) return plan;
	const chain = new Set<string>([root.ref]);
	let current = root.ref;
	for (let depth = 0; depth < 24; depth++) {
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
	if (!plan.owner) return plan;
	plan.refs = chain;
	const pending = [...(index.children.get(plan.owner.ref) ?? [])];
	const visited = new Set<string>([plan.owner.ref]);
	for (let position = 0; position < pending.length; position++) {
		const ref = pending[position]!;
		if (visited.has(ref) || ref === root.ref) continue;
		visited.add(ref);
		const entity = index.byRef.get(ref);
		if (!entity) {
			plan.unavailable = true;
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
	return plan;
}

export function assessTaskContext(options: {
	anchor: Entity;
	localRefs: Set<string>;
	candidates: Map<string, Entity>;
	selected: Map<string, Entity>;
	ownerPlan: OwnerContextPlan;
	intent: string;
	focused: boolean;
	captureIncomplete: boolean;
}): TaskContextRequirements {
	const { anchor, localRefs, candidates, selected, ownerPlan, intent, captureIncomplete } = options;
	const retained = (refs: Iterable<string>) => [...refs].every((ref) => selected.has(ref));
	const local = captureIncomplete || !retained(localRefs) ? "incomplete" : "complete";
	const needsOwner =
		ownerPlan.requiresOwner ||
		anchor.state.editable ||
		!!anchor.actionability?.actions.length ||
		(intent === "interact" && options.focused);
	const owner = ownerPlan.owner
		? selected.has(ownerPlan.owner.ref)
			? "complete"
			: "incomplete"
		: needsOwner
			? "unknown"
			: "not-applicable";
	const identity = ownerPlan.owner
		? ownerPlan.unknownBoundaries.size
			? "unknown"
			: captureIncomplete || ownerPlan.unavailable || !retained(candidates.keys())
				? "incomplete"
				: "complete"
		: needsOwner
			? "unknown"
			: "not-applicable";
	const actions = [...candidates.values()].filter((entity) => entity.actionability?.actions.length);
	const actionCoverage =
		!needsOwner || (intent !== "interact" && !anchor.state.editable)
			? "not-applicable"
			: ownerPlan.unknownBoundaries.size || captureIncomplete || ownerPlan.unavailable || !actions.length
				? "unknown"
				: retained(actions.map((entity) => entity.ref))
					? "complete"
					: "incomplete";
	return { local, owner, identity, actions: actionCoverage };
}
