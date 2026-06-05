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
import { isRecord } from "../utils/records.js";

// A group becomes a template only at this many members (below it, the entities are just listed).
export const MIN_TEMPLATE_INSTANCES = 4;
// Handles are lossless but capped — the true size is always `count`; beyond the cap the model pages
// via the listed refs / a fresh observe.
export const MAX_TEMPLATE_INSTANCE_REFS = 20;
export const MAX_TEMPLATES = 12;

// Per-instance fields whose variation we track. A field that DIFFERS across instances is listed in
// `varies` (the model must read it per instance); a field uniform across all is stated once in
// `constant` (only when interesting — see buildTemplate).
export type TemplateVaryField = "name" | "value" | "checked" | "selected" | "pressed" | "current" | "disabled";
const VARY_FIELDS: TemplateVaryField[] = ["name", "value", "checked", "selected", "pressed", "current", "disabled"];

export type TemplateGroupDescriptor = {
	key: string;
	container?: string;
	containerName?: string;
	role: string;
	kind: EntityKind;
	setSize?: number;
};

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

export type TemplateSummary = { templates: StructureTemplate[] };

function str(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text ? text : undefined;
}

function containerRoleOf(entity: Entity): string | undefined {
	return isRecord(entity.hints) ? str(entity.hints.containerRole) : undefined;
}

function containerNameOf(entity: Entity): string | undefined {
	return isRecord(entity.hints) ? str(entity.hints.containerName) : undefined;
}

// The ARIA repetition signal for an entity, or undefined when it carries none. ["c", role, name] =
// AX container membership (primary); ["s", setSize] = a declared aria-setsize set (secondary, only
// when already template-sized). Note: two distinct UNNAMED lists with the same containerRole collapse
// to one template (the AX layer gives role+name, not a container identity) — an acceptable over-fold
// for M1 (the shape stays correct; count is the sum); a container ref identity is a future refinement.
function groupSignalOf(entity: Entity): ["c", string, string] | ["s", number] | undefined {
	const containerRole = containerRoleOf(entity);
	if (containerRole) return ["c", containerRole, containerNameOf(entity) ?? ""];
	const setSize = entity.structure?.setSize;
	if (typeof setSize === "number" && setSize >= MIN_TEMPLATE_INSTANCES) return ["s", setSize];
	return undefined;
}

export function templateGroupDescriptorForEntity(entity: Entity): TemplateGroupDescriptor | undefined {
	const signal = groupSignalOf(entity);
	if (!signal) return undefined;
	const key = JSON.stringify([signal, entity.role, entity.kind]);
	if (signal[0] === "c") {
		const [, container, containerName] = signal;
		const setSize = entity.structure?.setSize;
		return {
			key,
			...(container ? { container } : {}),
			...(containerName ? { containerName } : {}),
			role: entity.role,
			kind: entity.kind,
			...(typeof setSize === "number" ? { setSize } : {}),
		};
	}
	const [, setSize] = signal;
	return { key, role: entity.role, kind: entity.kind, setSize };
}

function fieldValue(entity: Entity, field: TemplateVaryField): unknown {
	if (field === "name") return entity.name;
	if (field === "value") return entity.value;
	return entity.state[field];
}

function buildTemplate(members: Entity[]): StructureTemplate {
	const first = members[0];
	const role = first.role;
	const kind = first.kind;
	const varies: TemplateVaryField[] = [];
	const constant: Record<string, unknown> = { role, kind };
	for (const field of VARY_FIELDS) {
		const head = fieldValue(first, field);
		const uniform = members.every((member) => fieldValue(member, field) === head);
		if (!uniform) {
			varies.push(field);
			continue;
		}
		// Uniform → state once in `constant`, but only when interesting: name/value if present; a state
		// flag only if truthy (a uniform disabled:false is the default — omit it to stay compact).
		if (field === "name" || field === "value") {
			if (head !== undefined) constant[field] = head;
		} else if (head !== undefined && head !== false) {
			constant[field] = head;
		}
	}
	const container = containerRoleOf(first);
	const containerName = container ? containerNameOf(first) : undefined;
	const setSize = members.find((member) => typeof member.structure?.setSize === "number")?.structure?.setSize;
	const sample: StructureTemplate["sample"] = { ref: first.ref, ...(first.name ? { name: first.name } : {}), ...(first.value ? { value: first.value } : {}) };
	return {
		...(container ? { container } : {}),
		...(containerName ? { containerName } : {}),
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

export function structureScopeKey(descriptor: Pick<TemplateGroupDescriptor, "container" | "containerName" | "setSize">): string {
	return descriptor.container
		? JSON.stringify(["c", descriptor.container, descriptor.containerName || ""])
		: JSON.stringify(["s", descriptor.setSize ?? ""]);
}

export function isPureTextLeaf(descriptor: Pick<TemplateGroupDescriptor, "role" | "kind">): boolean {
	const role = descriptor.role.toLowerCase();
	return descriptor.kind === "text" || role === "inlinetextbox" || role === "statictext";
}

export function isActionableOrStructural(descriptor: Pick<TemplateGroupDescriptor, "role" | "kind">): boolean {
	if (isPureTextLeaf(descriptor)) return false;
	return descriptor.kind === "control" || descriptor.kind === "element" || descriptor.kind === "region";
}

export function templateRank(template: Pick<StructureTemplate, "role" | "kind">): number {
	if (template.kind === "control") return 0;
	if (template.kind === "element" && !isPureTextLeaf(template)) return 1;
	if (template.kind === "region") return 1;
	return 2;
}

// Fold repeated sibling entities (same AX container or aria-setsize set + same role/kind, ≥
// MIN_TEMPLATE_INSTANCES) into structure templates. Sorted by instance count desc, capped at
// MAX_TEMPLATES. Empty when nothing repeats. Budget-immune block for the observe envelope.
export function buildTemplateSummary(entities: Entity[]): TemplateSummary {
	const groups = new Map<string, Entity[]>();
	const descriptors = new Map<string, TemplateGroupDescriptor>();
	for (const entity of entities) {
		const descriptor = templateGroupDescriptorForEntity(entity);
		if (!descriptor) continue;
		// JSON key = unambiguous (no delimiter collisions even when containerName contains spaces).
		const list = groups.get(descriptor.key);
		if (list) list.push(entity);
		else {
			groups.set(descriptor.key, [entity]);
			descriptors.set(descriptor.key, descriptor);
		}
	}
	const templateSizedDescriptors = Array.from(groups.entries())
		.filter(([, members]) => members.length >= MIN_TEMPLATE_INSTANCES)
		.map(([key]) => descriptors.get(key))
		.filter((item): item is TemplateGroupDescriptor => !!item);
	const scopesWithStructuralTemplates = new Set(templateSizedDescriptors
		.filter(isActionableOrStructural)
		.map(structureScopeKey));
	const templates: StructureTemplate[] = [];
	for (const [key, members] of groups.entries()) {
		if (members.length < MIN_TEMPLATE_INSTANCES) continue;
		const descriptor = descriptors.get(key);
		if (descriptor && isPureTextLeaf(descriptor) && scopesWithStructuralTemplates.has(structureScopeKey(descriptor))) continue;
		templates.push(buildTemplate(members));
	}
	return { templates: templates.sort((a, b) => templateRank(a) - templateRank(b) || b.count - a.count).slice(0, MAX_TEMPLATES) };
}
