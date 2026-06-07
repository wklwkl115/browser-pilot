import assert from "node:assert/strict";

const { buildCliCommands } = await import(new URL("../../../cli/registry.ts", import.meta.url).href);
const { buildFlagSpecs } = await import(new URL("../../../cli/flags.ts", import.meta.url).href);

const MECHANICAL_PARAM_DENYLIST = new Set([
	"detailLevel",
	"maxChars",
	"timeoutMs",
	"browserSessionId",
	"outputPath",
	"maxBodyBytes",
	"maxDepth",
	"maxPages",
	"maxCases",
	"maxCandidates",
	"maxTemplates",
	"rateLimitPerSecond",
	"timeoutSeconds",
	"harMaxEntries",
	"followRedirects",
	"maxRedirects",
	"defaultScheme",
	"cookieMode",
	"redact",
]);

function allowed(toolName, paramName) {
	return toolName === "browser_tabs" && paramName === "browserSessionId";
}

for (const command of buildCliCommands()) {
	for (const spec of buildFlagSpecs(command.parameters)) {
		if (!MECHANICAL_PARAM_DENYLIST.has(spec.name) || allowed(command.name, spec.name)) continue;
		assert.fail(`${command.name} must not expose mechanical parameter ${spec.name} (${spec.flag})`);
	}
}

console.log("param surface ok — mechanical parameters are hidden from CLI-derived schemas");
