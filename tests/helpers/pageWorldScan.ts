import {
	PAGE_WORLD_SCAN_SCHEMA,
	type PageWorldScanBundleV1,
} from "../../src/kernels/abml/pageWorldScan.ts";

type ScanBundleOverrides = {
	page?: Partial<PageWorldScanBundleV1["page"]>;
	content?: Partial<PageWorldScanBundleV1["content"]>;
	structure?: Partial<PageWorldScanBundleV1["structure"]>;
	frames?: Partial<PageWorldScanBundleV1["frames"]>;
	signals?: {
		fingerprint?: Partial<PageWorldScanBundleV1["signals"]["fingerprint"]>;
		growthProbe?: PageWorldScanBundleV1["signals"]["growthProbe"];
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
			tree: "<main>Example</main>",
			headings: [],
			interactive: [],
			...overrides.content,
		},
		structure: {
			actionables: [],
			rows: [],
			listHints: [],
			canvasRegions: [],
			mediaCandidates: [],
			...overrides.structure,
		},
		frames: {
			notes: [],
			...overrides.frames,
		},
		signals: {
			fingerprint: {
				changeSeq: 1,
				...overrides.signals?.fingerprint,
			},
			...(overrides.signals?.growthProbe === undefined ? {} : { growthProbe: overrides.signals.growthProbe }),
		},
		stats: {
			nodeCount: 1,
			outputChars: 7,
			truncated: false,
			...overrides.stats,
		},
	};
}
