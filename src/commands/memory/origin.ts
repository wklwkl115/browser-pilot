import { createCodedError } from "../../utils/codedError.js";

const SUBDOMAIN_PREFIX_RE = /^(?:www2?|m|mobile|app)\./;

function isIpv4(host: string): boolean {
	return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isIpv6(host: string): boolean {
	return host.includes(":");
}

export function normalizeOriginKeyFromUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw createCodedError({ name: "MemoryOriginError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory url must be an absolute URL", details: { url } });
	}
	const host = parsed.hostname.toLowerCase();
	if (!host) throw createCodedError({ name: "MemoryOriginError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory url must have a hostname", details: { url } });
	if (host === "localhost" || isIpv4(host) || isIpv6(host)) return host;
	// Strip a single leading device/variant subdomain so the same site's mobile/app
	// surface shares memory with its main one (m.site.com ↔ site.com). Only strip
	// when ≥2 labels remain, so two-label apex domains whose first label happens to
	// be one of these (app.com, mobile.de, m.me) are NOT mangled to a bare TLD.
	const stripped = host.replace(SUBDOMAIN_PREFIX_RE, "");
	return stripped.includes(".") ? stripped : host;
}
