import {
	PAGE_WORLD_SCAN_SCHEMA,
	type PageWorldScanBundleV1,
} from "../../src/kernels/abml/pageWorldScan.ts";

type ScanBundleOverrides = {
	page?: Partial<PageWorldScanBundleV1["page"]>;
	content?: Partial<PageWorldScanBundleV1["content"]>;
	structure?: Partial<PageWorldScanBundleV1["structure"]>;
	signals?: {
		fingerprint?: Partial<PageWorldScanBundleV1["signals"]["fingerprint"]>;
	};
	stats?: Partial<PageWorldScanBundleV1["stats"]>;
};

export function pageWorldScanBundle(overrides: ScanBundleOverrides = {}): PageWorldScanBundleV1 {
	return {
		schema: PAGE_WORLD_SCAN_SCHEMA,
		page: {
			url: "https://example.test/",
			title: "Example",
			readyState: "complete",
			...overrides.page,
		},
		content: {
			text: "Example",
			headings: [],
			...overrides.content,
		},
		structure: {
			actionables: [],
			listHints: [],
			canvasRegions: [],
			...overrides.structure,
		},
		signals: {
			fingerprint: {
				changeSeq: 1,
				...overrides.signals?.fingerprint,
			},
		},
		stats: {
			nodeCount: 1,
			outputChars: 7,
			truncated: false,
			...overrides.stats,
		},
	};
}
