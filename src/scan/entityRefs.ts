import { buildControlsSourceEntity, buildDomEntityFromScanActionable, buildReferencedTargetEntity, buildRegionEntityFromListHint, buildVisionRegionFromCanvasActionable, type ScanEntityContext } from "../kernels/abml/entity.js";
import { registerRefDescriptor } from "../resources/resourceRefs.js";
import { isRecord } from "../utils/records.js";

type Built = ReturnType<typeof buildDomEntityFromScanActionable>;
type BuildFn = (node: Record<string, unknown>, index: number) => Built;

function asRecordArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function refFor(built: Built): string {
	return registerRefDescriptor({ descriptor: built.descriptor, resourceKind: "scan", name: built.entity.name || built.entity.role });
}

function annotateNode(node: Record<string, unknown>, slot: string, refId: string): Record<string, unknown> {
	const refs = isRecord(node.__browserPilotEntityRefs) ? node.__browserPilotEntityRefs : {};
	return { ...node, __browserPilotEntityRefs: { ...refs, [slot]: refId } };
}

function annotateArray(value: unknown, slot: string, build: BuildFn): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item, index) => {
		if (!isRecord(item)) return item;
		return annotateNode(item, slot, refFor(build(item, index)));
	});
}

export function registerScanEntityRefs(data: Record<string, unknown>, context: ScanEntityContext): Record<string, unknown> {
	const next: Record<string, unknown> = { ...data };
	next.actionables = annotateArray(data.actionables, "domAction", (node) => buildDomEntityFromScanActionable(node, context));
	next.references = annotateArray(data.references, "referencedTarget", (node) => buildReferencedTargetEntity(node, context));
	next.controls_pairs = annotateArray(data.controls_pairs, "controlsSource", (node) => buildControlsSourceEntity(node, context));
	next.list_hints = annotateArray(data.list_hints, "listRegion", (node, index) => buildRegionEntityFromListHint(node, context, index));

	const canvasRegions = asRecordArray(data.canvas_regions);
	if (canvasRegions.length) {
		next.canvas_regions = annotateArray(data.canvas_regions, "visionRegion", (node) => buildVisionRegionFromCanvasActionable(node, context));
	} else if (Array.isArray(next.actionables)) {
		next.actionables = next.actionables.map((item) => {
			if (!isRecord(item) || String(item.tag || "").toLowerCase() !== "canvas") return item;
			return annotateNode(item, "visionRegion", refFor(buildVisionRegionFromCanvasActionable(item, context)));
		});
	}
	return next;
}
