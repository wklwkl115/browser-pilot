// Semantic package/bridge expectations that do not have a better runtime ground truth.
// Runtime facts such as the current version are read from their source artifacts instead.
export const EXPECTED_PACKAGE_FACTS = {
	manifestServiceWorker: {
		value: "dist/service-worker.js",
		rationale: "MV3 must load the generated ESM service-worker bundle, not source files.",
	},
	syncProtocolScript: {
		value: "node scripts/sync-native-protocol.mjs",
		rationale: "native protocol outputs are generated from bridge/native_command_schema.json by this command.",
	},
	offscreenPermission: {
		value: "offscreen",
		rationale: "durable bridge transport owns the WebSocket in an MV3 offscreen document.",
	},
	offscreenDocument: {
		value: "offscreen.html",
		rationale: "the extension manifest/package must ship the offscreen transport document.",
	},
	offscreenBundle: {
		value: "dist/offscreen.js",
		rationale: "the offscreen document must load the generated transport bundle.",
	},
};
