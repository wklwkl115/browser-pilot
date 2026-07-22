import { buildControlsSourceEntity, buildDomEntityFromScanActionable, buildReferencedTargetEntity, buildRegionEntityFromListHint, buildVisionRegionFromCanvasActionable, dedupeEntities, withRegisteredRef, type Entity, type ScanEntityContext } from "../kernels/abml/entity.js";
import { summaryRefIdForDescriptor } from "../kernels/refs/refId.js";
import type { PageWorldScanBundleV1, ScanActionable, ScanCanvasRegion, ScanListHint } from "../kernels/abml/pageWorldScan.js";

export type ScanEntityOptions = {
	entityContext?: Partial<ScanEntityContext>;
	scanEntities?: ReturnType<typeof buildScanEntities>;
};

function scanEntityContext(item: PageWorldScanBundleV1, options: ScanEntityOptions): ScanEntityContext {
	const context = options.entityContext || {};
	const url = context.url ?? item.page.url;
	return {
		browserSessionId: context.browserSessionId,
		tabId: context.tabId,
		url,
		observationId: context.observationId ?? `scan:${url || "unknown"}`,
		capturedAt: context.capturedAt ?? item.signals.fingerprint.capturedAt ?? Date.now(),
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function nodeRefId(node: ScanActionable | ScanListHint | ScanCanvasRegion, built: { descriptor: Parameters<typeof summaryRefIdForDescriptor>[0] }, slot: string): string {
	return stringField(node.entityRefs?.[slot]) ?? summaryRefIdForDescriptor(built.descriptor);
}

function normalizeText(value: unknown): string {
	return String(value ?? "").toLowerCase().replace(/[\d$€£¥.,:;!?()[\]{}]+/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeEntitiesByRef(entities: Entity[]): Entity[] {
	const seen = new Set<string>();
	return entities.filter((entity) => {
		if (seen.has(entity.ref)) return false;
		seen.add(entity.ref);
		return true;
	});
}

function listHintDuplicateNames(listHints: ScanListHint[]): Set<string> {
	const counts = new Map<string, number>();
	for (const [index, item] of listHints.entries()) {
		const built = buildRegionEntityFromListHint(item, { observationId: "scan:list-hint-name", capturedAt: 0 }, index);
		const key = normalizeText(built.entity.name);
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function buildListRegionEntity(node: ScanListHint, context: ScanEntityContext, index: number, duplicateNames: ReadonlySet<string>): Entity {
	const built = buildRegionEntityFromListHint(node, context, index, duplicateNames);
	return withRegisteredRef(built.entity, nodeRefId(node, built, "listRegion"));
}

export function buildScanEntities(item: PageWorldScanBundleV1, options: ScanEntityOptions = {}): { entities: Entity[]; primaryEntities: Entity[]; listEntities: Entity[]; visualRegions: Entity[]; referencedEntities: Entity[]; controlsSources: Entity[] } {
	const context = scanEntityContext(item, options);
	const actionables = item.structure.actionables.filter((node) => node.referenceOnly !== true && node.relationOnly !== true);
	const references = item.structure.actionables.filter((node) => node.referenceOnly === true);
	const controlsPairs = item.structure.actionables.filter((node) => node.relationOnly === true);
	const actionEntities = dedupeEntities(actionables.map((node) => {
		const built = buildDomEntityFromScanActionable(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "domAction"));
	}));
	const referencedEntities = references.map((node) => {
		const built = buildReferencedTargetEntity(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "referencedTarget"));
	});
	const controlsSourceEntities = controlsPairs.map((node) => {
		const built = buildControlsSourceEntity(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "controlsSource"));
	});
	const canvasRegions = item.structure.canvasRegions.length
		? item.structure.canvasRegions
		: actionables.filter((node) => String(node.tag || "").toLowerCase() === "canvas");
	const visualRegions = dedupeEntities(canvasRegions.map((node) => {
		const built = buildVisionRegionFromCanvasActionable(node, context);
		return withRegisteredRef(built.entity, nodeRefId(node, built, "visionRegion"));
	}));
	const duplicateListNames = listHintDuplicateNames(item.structure.listHints);
	const listEntities = dedupeEntities(item.structure.listHints.map((node, index) => buildListRegionEntity(node, context, index, duplicateListNames)));
	const actionableSelectors = new Set(actionEntities.map((entity) => typeof entity.hints?.selector === "string" ? entity.hints.selector : null).filter(Boolean));
	const referencedOnly = referencedEntities.filter((entity) => typeof entity.hints?.selector !== "string" || !actionableSelectors.has(entity.hints.selector));
	const controlsSourceOnly = controlsSourceEntities.filter((entity) => typeof entity.hints?.selector !== "string" || !actionableSelectors.has(entity.hints.selector));
	const entities = dedupeEntities([...actionEntities, ...referencedOnly, ...controlsSourceOnly, ...listEntities, ...visualRegions]);
	const referencedSurvivors = [...referencedOnly, ...controlsSourceOnly].filter((entity) => entities.includes(entity));
	const actionableCandidates = actionEntities.filter((entity) => String(entity.hints?.jsonPath || "").startsWith("data.structure.actionables["));
	const highSignal = (entity: Entity) => entity.state?.current !== undefined && entity.state.current !== false || entity.state?.checked === true || entity.state?.selected === true || entity.state?.pressed === true;
	const top = actionableCandidates.slice(0, 10);
	const pinned = actionableCandidates.filter((entity) => highSignal(entity) && !top.includes(entity)).slice(0, 6);
	return {
		entities,
		primaryEntities: [...top, ...pinned],
		listEntities,
		visualRegions,
		referencedEntities: referencedSurvivors,
		controlsSources: controlsSourceOnly.filter((entity) => entities.includes(entity)),
	};
}

export function scanEntitiesForEnvelope(data: PageWorldScanBundleV1, options: ScanEntityOptions = {}): Entity[] {
	return scanEntitiesFromGroups(options.scanEntities ?? buildScanEntities(data, options));
}

export function scanEntitiesFromGroups(built: ReturnType<typeof buildScanEntities>): Entity[] {
	return dedupeEntitiesByRef([...built.entities, ...built.primaryEntities, ...built.listEntities, ...built.visualRegions, ...built.referencedEntities, ...built.controlsSources]);
}
