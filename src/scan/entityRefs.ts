import {
	buildControlsSourceEntity,
	buildDomEntityFromScanActionable,
	buildReferencedTargetEntity,
	buildRegionEntityFromListHint,
	buildVisionRegionFromCanvasActionable,
	type ScanEntityContext,
} from "../kernels/abml/entity.js";
import { registerRefDescriptor } from "../resources/resourceRefs.js";
import { isRecord } from "../utils/records.js";
import type { PageWorldScanBundleV1, ScanListHint } from "../kernels/abml/pageWorldScan.js";

type Built = ReturnType<typeof buildDomEntityFromScanActionable>;

export const REGISTERED_SCAN_REF_LIMITS = {
	actionables: 8_000,
	references: 400,
	controlsSources: 400,
	listRegions: 300,
	canvasRegions: 100,
} as const;

function refFor(built: Built): string {
	return registerRefDescriptor({ descriptor: built.descriptor });
}

function annotateNode<T extends object>(node: T, slot: string, refId: string) {
	const current = Reflect.get(node, "entityRefs");
	const refs = isRecord(current) ? current : {};
	return { ...node, entityRefs: { ...refs, [slot]: refId } };
}

function normalizeNameKey(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function listHintDuplicateNames(listHints: ScanListHint[], context: ScanEntityContext): Set<string> {
	const counts = new Map<string, number>();
	for (const [index, item] of listHints.entries()) {
		const name = buildRegionEntityFromListHint(item, context, index).entity.name;
		const key = normalizeNameKey(name);
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function registerScanEntityRefs(data: PageWorldScanBundleV1, context: ScanEntityContext): PageWorldScanBundleV1 {
	const primary = data.structure.actionables.filter(
		(item) => item.referenceOnly !== true && item.relationOnly !== true,
	);
	const references = data.structure.actionables.filter((item) => item.referenceOnly === true);
	const controlsSources = data.structure.actionables.filter((item) => item.relationOnly === true);
	const boundedActionables = [
		...primary.slice(0, REGISTERED_SCAN_REF_LIMITS.actionables),
		...references.slice(0, REGISTERED_SCAN_REF_LIMITS.references),
		...controlsSources.slice(0, REGISTERED_SCAN_REF_LIMITS.controlsSources),
	];
	const boundedListHints = data.structure.listHints.slice(0, REGISTERED_SCAN_REF_LIMITS.listRegions);
	const boundedCanvasRegions = data.structure.canvasRegions.slice(0, REGISTERED_SCAN_REF_LIMITS.canvasRegions);
	const refsTruncated =
		boundedActionables.length !== data.structure.actionables.length ||
		boundedListHints.length !== data.structure.listHints.length ||
		boundedCanvasRegions.length !== data.structure.canvasRegions.length;
	const actionables = boundedActionables.map((item) => {
		const node = item;
		if (node.referenceOnly === true)
			return annotateNode(node, "referencedTarget", refFor(buildReferencedTargetEntity(node, context)));
		if (node.relationOnly === true)
			return annotateNode(node, "controlsSource", refFor(buildControlsSourceEntity(node, context)));
		return annotateNode(node, "domAction", refFor(buildDomEntityFromScanActionable(node, context)));
	});
	const duplicateListNames = listHintDuplicateNames(boundedListHints, context);
	const nextListHints = boundedListHints.map((node, index) =>
		annotateNode(
			node,
			"listRegion",
			refFor(buildRegionEntityFromListHint(node, context, index, duplicateListNames)),
		),
	);

	let nextActionables = actionables;
	let nextCanvasRegions = boundedCanvasRegions;
	if (boundedCanvasRegions.length) {
		nextCanvasRegions = boundedCanvasRegions.map((node) =>
			annotateNode(node, "visionRegion", refFor(buildVisionRegionFromCanvasActionable(node, context))),
		);
	} else {
		nextActionables = actionables.map((item) => {
			if (String(item.tag || "").toLowerCase() !== "canvas") return item;
			return annotateNode(item, "visionRegion", refFor(buildVisionRegionFromCanvasActionable(item, context)));
		});
	}
	return {
		...data,
		structure: {
			...data.structure,
			actionables: nextActionables,
			listHints: nextListHints,
			canvasRegions: nextCanvasRegions,
		},
		stats: {
			...data.stats,
			...(refsTruncated ? { actionablesComplete: false } : {}),
		},
	};
}
