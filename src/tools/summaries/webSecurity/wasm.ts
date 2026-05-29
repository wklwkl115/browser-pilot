import { summaryTable, textPreview, type Summary } from "../common";
import { isRecord } from "../common";

export function summarizeWasmArtifactData(value: unknown): Summary {
	const root = isRecord(value) ? value : {};
	const input = isRecord(root.input) ? root.input : {};
	const analysis = isRecord(root.analysis) ? root.analysis : {};
	const sections = Array.isArray(analysis.sections) ? analysis.sections : [];
	const imports = Array.isArray(analysis.imports) ? analysis.imports : [];
	const exportsList = Array.isArray(analysis.exports) ? analysis.exports : [];
	return {
		ok: analysis.ok,
		input: {
			path: input.path,
			fileName: input.fileName,
			bytes: input.bytes,
			privacy: input.privacy,
		},
		format: analysis.format,
		version: analysis.version,
		sha256: analysis.sha256,
		sectionCount: analysis.sectionCount,
		counts: analysis.counts,
		sections: summaryTable(sections, [
			{ key: "id", value: (item) => isRecord(item) ? item.id : undefined },
			{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
			{ key: "bytes", value: (item) => isRecord(item) ? item.bytes : undefined },
			{ key: "offset", value: (item) => isRecord(item) ? item.offset : undefined },
		], 12),
		imports: summaryTable(imports, [
			{ key: "module", value: (item) => isRecord(item) ? item.module : undefined },
			{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
			{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
		], 12),
		exports: summaryTable(exportsList, [
			{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
			{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
			{ key: "index", value: (item) => isRecord(item) ? item.index : undefined },
		], 12),
		nextActions: [
			"read the explicit Wasm artifact path for raw module bytes when metadata is insufficient",
			"attach a mature Wasm bridge only after explicit local launcher/tool availability is confirmed",
		],
		summaryNote: textPreview("Wasm phase 1 is metadata-first and artifact-first; WAT/decompile output should remain a bridge artifact, not an inline dump.", 160),
	};
}
