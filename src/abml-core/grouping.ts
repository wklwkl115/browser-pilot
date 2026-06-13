import type { Entity, EntityKind } from "./entity.js";
import { isRecord } from "../utils/records.js";

export const MIN_TEMPLATE_INSTANCES = 4;

export type TemplateGroupDescriptor = {
	key: string;
	container?: string;
	containerName?: string;
	role: string;
	kind: EntityKind;
	setSize?: number;
};

export type IndexedEntity = { entity: Entity; index: number };
export type TemplateGroup = { descriptor: TemplateGroupDescriptor; members: IndexedEntity[] };

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

export function normalizeEntityText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	return text ? text.toLowerCase() : undefined;
}

export function displayEntityText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim().replace(/\s+/g, " ");
	return text ? text.slice(0, 120) : undefined;
}

let lastGroupedEntities: Entity[] | undefined;
let lastGroupedResult: TemplateGroup[] | undefined;

function buildGroups(entities: Entity[]): TemplateGroup[] {
	const groups = new Map<string, TemplateGroup>();
	entities.forEach((entity, index) => {
		const descriptor = templateGroupDescriptorForEntity(entity);
		if (!descriptor) return;
		const group = groups.get(descriptor.key);
		if (group) group.members.push({ entity, index });
		else groups.set(descriptor.key, { descriptor, members: [{ entity, index }] });
	});
	return Array.from(groups.values()).filter((group) => group.members.length >= MIN_TEMPLATE_INSTANCES);
}

export function groupEntities(entities: Entity[]): TemplateGroup[] {
	if (entities === lastGroupedEntities && lastGroupedResult) return lastGroupedResult.slice();
	const groups = buildGroups(entities);
	lastGroupedEntities = entities;
	lastGroupedResult = groups;
	return groups.slice();
}

export function suppressNestedNonControlGroups<T extends TemplateGroup>(groups: T[]): T[] {
	const scopesWithControls = new Set(groups.filter((group) => group.descriptor.kind === "control").map((group) => structureScopeKey(group.descriptor)));
	if (!scopesWithControls.size) return groups;
	return groups.filter((group) => group.descriptor.kind === "control" || !scopesWithControls.has(structureScopeKey(group.descriptor)));
}
