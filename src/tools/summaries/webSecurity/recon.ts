import { bodyPreview, fingerprintPreview, hostOf, increment, isRecord, resultItems, summaryTable, techPreview, topCounts, type Summary } from "./shared";

export function summarizeWebReconProbeData(value: unknown): Summary {
	const items = resultItems(value);
	const statusCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	let failed = 0;
	for (const item of items) {
		if (item.ok === false) failed += 1;
		increment(statusCounts, item.status ?? (item.ok === false ? "error" : "unknown"));
		increment(hostCounts, hostOf(item.finalUrl ?? item.inputUrl));
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		count: items.length,
		failed,
		statusCounts: topCounts(statusCounts),
		hostCounts: topCounts(hostCounts),
		results: summaryTable(items, [
			{ key: "url", value: (item) => item.finalUrl ?? item.inputUrl },
			{ key: "status", value: (item) => item.status ?? (item.ok === false ? "error" : undefined) },
			{ key: "title", value: (item) => item.title },
			{ key: "tech", value: (item) => techPreview(item.tech) },
			{ key: "fingerprints", value: (item) => fingerprintPreview(item.fingerprints) },
			{ key: "redirects", value: (item) => Array.isArray(item.redirects) ? item.redirects.length : 0 },
			{ key: "bodyBytes", value: (item) => isRecord(item.body) ? item.body.bytes : undefined },
			{ key: "bodySha256", value: (item) => isRecord(item.body) ? item.body.sha256 : undefined },
			{ key: "favicon", value: (item) => isRecord(item.favicon) ? item.favicon.mmh3 ?? item.favicon.sha256 ?? item.favicon.error : undefined },
			{ key: "faviconSimHash", value: (item) => isRecord(item.favicon) ? item.favicon.simHash64 : undefined },
			{ key: "tls", value: (item) => isRecord(item.tlsCertificate) ? item.tlsCertificate.fingerprint256 || item.tlsCertificate.error : undefined },
			{ key: "preview", value: (item) => bodyPreview(item.body) || item.error },
		], 20),
		nextActions: [
			"use browser_crawl for bounded same-origin discovery when fingerprint results show interesting pages or APIs",
			"use browser_template for exposure checks against discovered hosts, redirects, or technology hints",
			"capture or replay specific requests with browser_network or browser_http_replay before deeper fuzzing or SQLi checks",
		],
	};
}
