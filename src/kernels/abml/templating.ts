// ABML mechanism arm — M1 structure templating (pure core).
//
// Large pages are flat + full: a 200-row table or a 50-card feed re-emits N near-identical entities.
// This selector groups repeated siblings while preserving every instance ref. Model-facing folding
// happens later at the observation resource boundary.
//
// Grouping is ARIA-grounded ONLY (the generality rule — works identically on native HTML / Vue /
// React / Web Components): members share an AX container (`hints.containerRole` + `containerName`,
// from the AX-membership merge) or a declared `aria-setsize`, plus the same `role` + `kind`.
// No tag/class/selector-prefix matching (that overfits a framework's DOM). Pure: zero browser/Node deps.
import { isAddressableEntity, type Entity, type EntityKind } from "./entity.js";
import { isPureTextLeaf, templateGroupDescriptorForEntity } from "./grouping.js";

// Per-instance fields whose variation we track. A field that DIFFERS across instances is listed in
// `varies` (the model must read it per instance); a field uniform across all is stated once in
// `constant` (only when interesting — see buildTemplate).
export type TemplateVaryField = "name" | "value" | "checked" | "selected" | "pressed" | "current" | "disabled";
const VARY_FIELDS: TemplateVaryField[] = ["name", "value", "checked", "selected", "pressed", "current", "disabled"];

export type StructureTemplate = {
	container?: string; // AX containerRole (list/grid/menu/group/…) when grouped by container
	containerName?: string;
	containerKey?: string;
	role: string; // members' shared role
	kind: EntityKind; // members' shared kind
	count: number; // number of folded instances (the true size)
	setSize?: number; // declared aria-setsize, if any (may exceed count when virtualized)
	varies: TemplateVaryField[]; // fields that differ instance-to-instance
	constant: Record<string, unknown>; // fields identical across all (role/kind always; uniform-truthy state)
	defaults: Record<string, unknown>; // modal values for varying fields
	exceptions: Array<{ index: number; ref?: string; values: Record<string, unknown> }>;
	instanceRefs: string[];
	sample?: { ref?: string; name?: string; value?: string }; // one representative instance
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
	const defaults: Record<string, unknown> = {};
	const defaultByField = new Map<TemplateVaryField, unknown>();
	for (const field of VARY_FIELDS) {
		const head = templateFieldValue(first, field);
		const uniform = members.every((member) => templateFieldValue(member, field) === head);
		if (!uniform) {
			varies.push(field);
			const counts = new Map<string, { value: unknown; count: number; first: number }>();
			members.forEach((member, index) => {
				const value = templateFieldValue(member, field);
				const key = value === undefined ? "undefined" : JSON.stringify(value);
				const current = counts.get(key);
				if (current) current.count += 1;
				else counts.set(key, { value, count: 1, first: index });
			});
			const selected = [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]!;
			defaultByField.set(field, selected.value);
			if (selected.value !== undefined) defaults[field] = selected.value;
			continue;
		}
		if (field === "name" || field === "value") {
			if (head !== undefined) constant[field] = head;
		} else if (head !== undefined && head !== false) {
			constant[field] = head;
		}
	}
	const exceptions = members.flatMap((member, index) => {
		const values: Record<string, unknown> = {};
		for (const field of varies) {
			const value = templateFieldValue(member, field);
			if (value !== defaultByField.get(field)) values[field] = value ?? null;
		}
		return Object.keys(values).length ? [{ index, ...(isAddressableEntity(member) ? { ref: member.ref } : {}), values }] : [];
	});
	const setSize = typeof descriptor?.setSize === "number"
		? descriptor.setSize
		: members.find((member) => typeof member.structure?.setSize === "number")?.structure?.setSize;
	const sampleValue = {
		...(isAddressableEntity(first) ? { ref: first.ref } : {}),
		...(first.name ? { name: first.name } : {}),
		...(first.value ? { value: first.value } : {}),
	};
	const sample: StructureTemplate["sample"] = Object.keys(sampleValue).length ? sampleValue : undefined;
	return {
		...(descriptor?.container ? { container: descriptor.container } : {}),
		...(descriptor?.containerName ? { containerName: descriptor.containerName } : {}),
		...(descriptor?.containerKey ? { containerKey: descriptor.containerKey } : {}),
		role,
		kind,
		count: members.length,
		...(typeof setSize === "number" ? { setSize } : {}),
		varies,
		constant,
		defaults,
		exceptions,
		instanceRefs: members.filter(isAddressableEntity).map((member) => member.ref),
		...(sample ? { sample } : {}),
	};
}

export function templateRank(template: Pick<StructureTemplate, "role" | "kind">): number {
	if (template.kind === "control") return 0;
	if (template.kind === "element" && !isPureTextLeaf(template)) return 1;
	if (template.kind === "region") return 1;
	return 2;
}
