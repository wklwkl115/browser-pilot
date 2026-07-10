// ABML mechanism arm — M1 structure templating (pure core).
//
// Large pages are flat + full: a 200-row table or a 50-card feed re-emits N near-identical entities
// at O(N) tokens even though they are one repeated shape. This selector folds repeated SIBLING
// entities into one template + N compact instances + handles: "20 of these, each differing in
// {name}", with every instance still reachable by `read(ref)`.
//
// Grouping is ARIA-grounded ONLY (the generality rule — works identically on native HTML / Vue /
// React / Web Components): members share an AX container (`hints.containerRole` + `containerName`,
// from the P3-2 AX-membership merge) or a declared `aria-setsize`, plus the same `role` + `kind`.
// No tag/class/selector-prefix matching (that overfits a framework's DOM). Pure: zero browser/Node deps.
import type { Entity, EntityKind } from "./entity.js";
import { isPureTextLeaf, templateGroupDescriptorForEntity } from "./grouping.js";

// Handles are lossless but capped — the true size is always `count`; beyond the cap the model pages
// via the listed refs / a fresh observe.
export const MAX_TEMPLATE_INSTANCE_REFS = 20;
export const MAX_TEMPLATES = 12;

// Per-instance fields whose variation we track. A field that DIFFERS across instances is listed in
// `varies` (the model must read it per instance); a field uniform across all is stated once in
// `constant` (only when interesting — see buildTemplate).
export type TemplateVaryField = "name" | "value" | "checked" | "selected" | "pressed" | "current" | "disabled";
const VARY_FIELDS: TemplateVaryField[] = ["name", "value", "checked", "selected", "pressed", "current", "disabled"];

export type StructureTemplate = {
	container?: string; // AX containerRole (list/grid/menu/group/…) when grouped by container
	containerName?: string;
	role: string; // members' shared role
	kind: EntityKind; // members' shared kind
	count: number; // number of folded instances (the true size)
	setSize?: number; // declared aria-setsize, if any (may exceed count when virtualized)
	varies: TemplateVaryField[]; // fields that differ instance-to-instance
	constant: Record<string, unknown>; // fields identical across all (role/kind always; uniform-truthy state)
	instanceRefs: string[]; // member refs (capped at MAX_TEMPLATE_INSTANCE_REFS; true size = count)
	sample?: { ref: string; name?: string; value?: string }; // one representative instance
};

export function templateFieldValue(entity: Entity, field: TemplateVaryField): unknown {
	if (field === "name") return entity.name;
	if (field === "value") return entity.value;
	return entity.state[field];
}

export function buildTemplate(members: Entity[]): StructureTemplate {
	const first = members[0]!;
	const descriptor = templateGroupDescriptorForEntity(first);
	const role = first.role;
	const kind = first.kind;
	const varies: TemplateVaryField[] = [];
	const constant: Record<string, unknown> = { role, kind };
	for (const field of VARY_FIELDS) {
		const head = templateFieldValue(first, field);
		const uniform = members.every((member) => templateFieldValue(member, field) === head);
		if (!uniform) {
			varies.push(field);
			continue;
		}
		if (field === "name" || field === "value") {
			if (head !== undefined) constant[field] = head;
		} else if (head !== undefined && head !== false) {
			constant[field] = head;
		}
	}
	const setSize = typeof descriptor?.setSize === "number"
		? descriptor.setSize
		: members.find((member) => typeof member.structure?.setSize === "number")?.structure?.setSize;
	const sample: StructureTemplate["sample"] = {
		ref: first.ref,
		...(first.name ? { name: first.name } : {}),
		...(first.value ? { value: first.value } : {}),
	};
	return {
		...(descriptor?.container ? { container: descriptor.container } : {}),
		...(descriptor?.containerName ? { containerName: descriptor.containerName } : {}),
		role,
		kind,
		count: members.length,
		...(typeof setSize === "number" ? { setSize } : {}),
		varies,
		constant,
		instanceRefs: members.slice(0, MAX_TEMPLATE_INSTANCE_REFS).map((member) => member.ref),
		sample,
	};
}

export function templateRank(template: Pick<StructureTemplate, "role" | "kind">): number {
	if (template.kind === "control") return 0;
	if (template.kind === "element" && !isPureTextLeaf(template)) return 1;
	if (template.kind === "region") return 1;
	return 2;
}
