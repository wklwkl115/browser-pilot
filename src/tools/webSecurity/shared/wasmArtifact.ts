import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
export const WASM_MAX_INPUT_BYTES = 8 * 1024 * 1024;

export type WasmArtifactErrorCode =
	| "WASM_LEB128_INVALID"
	| "WASM_TRUNCATED"
	| "WASM_INPUT_NOT_FILE"
	| "WASM_INPUT_TOO_LARGE"
	| "WASM_TOO_SMALL"
	| "WASM_MAGIC_INVALID";

export class WasmArtifactError extends Error {
	readonly code: WasmArtifactErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: WasmArtifactErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "WasmArtifactError";
		this.code = code;
		this.details = details;
	}
}

export type WasmArtifactInput = {
	path: string;
	maxBytes?: number;
};

export type WasmSectionFact = {
	id: number;
	name: string;
	bytes: number;
	offset: number;
};

export type WasmImportFact = {
	module: string;
	name: string;
	kind: "func" | "table" | "memory" | "global" | "tag" | "unknown";
};

export type WasmExportFact = {
	name: string;
	kind: "func" | "table" | "memory" | "global" | "tag" | "unknown";
	index: number;
};

export type WasmArtifactAnalysis = {
	input: {
		path: string;
		fileName: string;
		bytes: number;
		privacy: { localOnly: true; artifactFirst: true };
	};
	analysis: {
		ok: true;
		format: "wasm";
		version: number;
		sha256: string;
		sectionCount: number;
		sections: WasmSectionFact[];
		imports: WasmImportFact[];
		exports: WasmExportFact[];
		counts: {
			functions: number;
			tables: number;
			memories: number;
			globals: number;
			imports: number;
			exports: number;
		};
	};
};

const SECTION_NAMES: Record<number, string> = {
	0: "custom",
	1: "type",
	2: "import",
	3: "function",
	4: "table",
	5: "memory",
	6: "global",
	7: "export",
	8: "start",
	9: "element",
	10: "code",
	11: "data",
	12: "dataCount",
	13: "tag",
};

function normalizedMaxBytes(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return WASM_MAX_INPUT_BYTES;
	return Math.max(512, Math.min(WASM_MAX_INPUT_BYTES, Math.floor(n)));
}

function readVarUint(buffer: Buffer, offset: number): { value: number; next: number } {
	let result = 0;
	let shift = 0;
	let cursor = offset;
	while (cursor < buffer.length) {
		const byte = buffer[cursor];
		result |= (byte & 0x7f) << shift;
		cursor += 1;
		if ((byte & 0x80) === 0) return { value: result >>> 0, next: cursor };
		shift += 7;
		if (shift > 35) throw new WasmArtifactError("WASM_LEB128_INVALID", "Invalid Wasm varuint encoding", { offset });
	}
	throw new WasmArtifactError("WASM_TRUNCATED", "Unexpected end of Wasm binary while decoding varuint", { offset });
}

function readName(buffer: Buffer, offset: number): { value: string; next: number } {
	const length = readVarUint(buffer, offset);
	const end = length.next + length.value;
	if (end > buffer.length) throw new WasmArtifactError("WASM_TRUNCATED", "Unexpected end of Wasm binary while decoding name", { offset, length: length.value });
	return { value: buffer.toString("utf8", length.next, end), next: end };
}

function externalKind(byte: number): WasmImportFact["kind"] {
	if (byte === 0x00) return "func";
	if (byte === 0x01) return "table";
	if (byte === 0x02) return "memory";
	if (byte === 0x03) return "global";
	if (byte === 0x04) return "tag";
	return "unknown";
}

function skipLimits(buffer: Buffer, offset: number): number {
	if (offset >= buffer.length) throw new WasmArtifactError("WASM_TRUNCATED", "Unexpected end of Wasm binary while decoding limits", { offset });
	const flags = buffer[offset];
	let cursor = offset + 1;
	cursor = readVarUint(buffer, cursor).next;
	if (flags & 0x01) cursor = readVarUint(buffer, cursor).next;
	return cursor;
}

function skipImportDesc(buffer: Buffer, offset: number, kind: WasmImportFact["kind"]): number {
	let cursor = offset;
	if (kind === "func") return readVarUint(buffer, cursor).next;
	if (kind === "table") {
		cursor += 1;
		return skipLimits(buffer, cursor);
	}
	if (kind === "memory") return skipLimits(buffer, cursor);
	if (kind === "global") return cursor + 2;
	if (kind === "tag") return readVarUint(buffer, cursor + 1).next;
	return cursor;
}

function parseImportSection(buffer: Buffer): WasmImportFact[] {
	const imports: WasmImportFact[] = [];
	let cursor = 0;
	const count = readVarUint(buffer, cursor);
	cursor = count.next;
	for (let index = 0; index < count.value; index += 1) {
		const mod = readName(buffer, cursor);
		cursor = mod.next;
		const field = readName(buffer, cursor);
		cursor = field.next;
		const kind = externalKind(buffer[cursor]);
		cursor += 1;
		cursor = skipImportDesc(buffer, cursor, kind);
		imports.push({ module: mod.value, name: field.value, kind });
	}
	return imports;
}

function parseExportSection(buffer: Buffer): WasmExportFact[] {
	const exportsList: WasmExportFact[] = [];
	let cursor = 0;
	const count = readVarUint(buffer, cursor);
	cursor = count.next;
	for (let index = 0; index < count.value; index += 1) {
		const name = readName(buffer, cursor);
		cursor = name.next;
		const kind = externalKind(buffer[cursor]);
		cursor += 1;
		const itemIndex = readVarUint(buffer, cursor);
		cursor = itemIndex.next;
		exportsList.push({ name: name.value, kind, index: itemIndex.value });
	}
	return exportsList;
}

function parseCountSection(buffer: Buffer): number {
	return readVarUint(buffer, 0).value;
}

export async function analyzeWasmArtifact(input: WasmArtifactInput): Promise<WasmArtifactAnalysis> {
	const absPath = path.resolve(input.path);
	const info = await stat(absPath);
	if (!info.isFile()) throw new WasmArtifactError("WASM_INPUT_NOT_FILE", "Wasm input path must be a file", { path: absPath });
	const maxBytes = normalizedMaxBytes(input.maxBytes);
	if (info.size > maxBytes) throw new WasmArtifactError("WASM_INPUT_TOO_LARGE", "Wasm input exceeds bounded byte limit", { path: absPath, bytes: info.size, maxBytes });
	const buffer = await readFile(absPath);
	if (buffer.length < 8) throw new WasmArtifactError("WASM_TOO_SMALL", "Wasm input is smaller than the Wasm header", { path: absPath, bytes: buffer.length });
	if (!buffer.subarray(0, 4).equals(WASM_MAGIC)) throw new WasmArtifactError("WASM_MAGIC_INVALID", "Input is not a valid Wasm module header", { path: absPath });
	const version = buffer.readUInt32LE(4);
	const sections: WasmSectionFact[] = [];
	let cursor = 8;
	const counts = { functions: 0, tables: 0, memories: 0, globals: 0, imports: 0, exports: 0 };
	let imports: WasmImportFact[] = [];
	let exportsList: WasmExportFact[] = [];
	while (cursor < buffer.length) {
		const id = buffer[cursor];
		const size = readVarUint(buffer, cursor + 1);
		const start = size.next;
		const end = start + size.value;
		if (end > buffer.length) throw new WasmArtifactError("WASM_TRUNCATED", "Wasm section extends past the file end", { id, offset: cursor, size: size.value });
		sections.push({ id, name: SECTION_NAMES[id] || `section-${id}`, bytes: size.value, offset: cursor });
		const payload = buffer.subarray(start, end);
		if (id === 2) {
			imports = parseImportSection(payload);
			counts.imports = imports.length;
		} else if (id === 3) counts.functions = parseCountSection(payload);
		else if (id === 4) counts.tables = parseCountSection(payload);
		else if (id === 5) counts.memories = parseCountSection(payload);
		else if (id === 6) counts.globals = parseCountSection(payload);
		else if (id === 7) {
			exportsList = parseExportSection(payload);
			counts.exports = exportsList.length;
		}
		cursor = end;
	}
	return {
		input: {
			path: absPath,
			fileName: path.basename(absPath),
			bytes: buffer.length,
			privacy: { localOnly: true, artifactFirst: true },
		},
		analysis: {
			ok: true,
			format: "wasm",
			version,
			sha256: createHash("sha256").update(buffer).digest("hex"),
			sectionCount: sections.length,
			sections,
			imports,
			exports: exportsList,
			counts,
		},
	};
}
