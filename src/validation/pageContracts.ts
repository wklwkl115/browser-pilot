import { Value } from "typebox/value";
import { PAGE_WORLD_SCAN_BUNDLE_JSON_SCHEMA, type PageWorldScanBundleV1, type ScanBundleValidation } from "../kernels/abml/pageWorldScan.js";
import { PAGE_OBSERVATION_V3_JSON_SCHEMA, PAGE_OBSERVATION_VIEW_JSON_SCHEMA, type PageObservationV3, type PageObservationView } from "../kernels/abml/pageObservation.js";

function issueText(error: { keyword?: string; instancePath?: string; message?: string; params?: Record<string, unknown> }): string {
	const path = error.instancePath || "/";
	return error.keyword === "const" && error.params && "allowedValue" in error.params
		? `${path}: expected ${String(error.params.allowedValue)}`
		: `${path}: ${error.message || "invalid value"}`;
}

export function validatePageWorldScanBundle(value: unknown): ScanBundleValidation {
	return Value.Check(PAGE_WORLD_SCAN_BUNDLE_JSON_SCHEMA, value)
		? { ok: true, value: value as PageWorldScanBundleV1 }
		: { ok: false, issues: [...Value.Errors(PAGE_WORLD_SCAN_BUNDLE_JSON_SCHEMA, value)].map(issueText) };
}

export function isPageObservationV3(value: unknown): value is PageObservationV3 {
	return Value.Check(PAGE_OBSERVATION_V3_JSON_SCHEMA, value);
}

export function isPageObservationView(value: unknown): value is PageObservationView {
	return Value.Check(PAGE_OBSERVATION_VIEW_JSON_SCHEMA, value);
}
