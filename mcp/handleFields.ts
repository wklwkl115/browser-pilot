/**
 * Side-table of handle/ref-accepting fields per tool.
 *
 * Each entry declares that the named field may receive a browser-result:// or
 * pi-ref:// handle string in addition to its normal schema type. The MCP adapter
 * resolves handles BEFORE TypeBox validation, so the expanded payload is still
 * validated normally.
 *
 * This does NOT modify tool registration schemas (src/tools/) — handle/ref
 * acceptance is an MCP adapter concern, not a core tool concern. Pi-path
 * callers never see handle strings.
 */
import type { ResourceKind } from "./resourceStore.js";

export type HandleFieldDeclaration = {
	field: string;
	expectKind: ResourceKind;
	description: string;
};

export const HANDLE_ACCEPTING_FIELDS: Record<string, HandleFieldDeclaration[]> = {
	browser_sqli: [
		{
			field: "request",
			expectKind: "http-request",
			description: "Captured HTTP request object. Accepts a browser-result:// or pi-ref:// handle from a prior browser_network or browser_http_replay call.",
		},
	],
	browser_http_replay: [
		{
			field: "request",
			expectKind: "http-request",
			description: "Captured HTTP request-like object. Accepts a browser-result:// or pi-ref:// handle from a prior browser_network capture.",
		},
	],
	browser_fuzz: [
		{
			field: "request",
			expectKind: "http-request",
			description: "Captured request-like object for param mode. Accepts a browser-result:// or pi-ref:// handle from a prior browser_network or browser_http_replay call.",
		},
	],
};
