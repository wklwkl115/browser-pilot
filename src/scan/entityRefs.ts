import { buildControlsSourceEntity, buildDomEntityFromScanActionable, buildReferencedTargetEntity, buildRegionEntityFromListHint, buildVisionRegionFromCanvasActionable, type ScanEntityContext } from "../kernels/abml/entity.js";
import { registerRefDescriptor } from "../resources/resourceRefs.js";
import { isRecord } from "../utils/records.js";
import type { PageWorldScanBundleV1, ScanListHint } from "../kernels/abml/pageWorldScan.js";

type Built = ReturnType<typeof buildDomEntityFromScanActionable>;

function refFor(built: Built): string {
	return registerRefDescriptor({ descriptor: built.descriptor, resourceKind: "scan", name: built.entity.name || built.entity.role });
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
	const actionables = data.structure.actionables.map((item) => {
		const node = item;
		if (node.referenceOnly === true) return annotateNode(node, "referencedTarget", refFor(buildReferencedTargetEntity(node, context)));
		if (node.relationOnly === true) return annotateNode(node, "controlsSource", refFor(buildControlsSourceEntity(node, context)));
		return annotateNode(node, "domAction", refFor(buildDomEntityFromScanActionable(node, context)));
	});
	const duplicateListNames = listHintDuplicateNames(data.structure.listHints, context);
	const nextListHints = data.structure.listHints.map((node, index) => annotateNode(node, "listRegion", refFor(buildRegionEntityFromListHint(node, context, index, duplicateListNames))));

	let nextActionables = actionables;
	let nextCanvasRegions = data.structure.canvasRegions;
	if (data.structure.canvasRegions.length) {
		nextCanvasRegions = data.structure.canvasRegions.map((node) => annotateNode(node, "visionRegion", refFor(buildVisionRegionFromCanvasActionable(node, context))));
	} else {
		nextActionables = actionables.map((item) => {
			if (String(item.tag || "").toLowerCase() !== "canvas") return item;
			return annotateNode(item, "visionRegion", refFor(buildVisionRegionFromCanvasActionable(item, context)));
		});
	}
	return {
		...data,
		structure: { ...data.structure, actionables: nextActionables, listHints: nextListHints, canvasRegions: nextCanvasRegions },
	};
}
