import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";

const validationModuleUrl = pathToFileURL(path.resolve("D:/Node/node_global/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/validation.js")).href;
const { validateToolArguments } = await import(validationModuleUrl);

const strictTool = {
	name: "framework-parameter-fixture",
	parameters: Type.Object({
		flag: Type.Optional(Type.Boolean()),
		count: Type.Optional(Type.Number()),
		mode: Type.Optional(Type.Union([Type.Literal("scan"), Type.Literal("html")], { description: "scan | html" })),
	}, { additionalProperties: false }),
};

const converted = validateToolArguments(strictTool, {
	name: strictTool.name,
	arguments: { flag: "true", count: "30", mode: "scan" },
});
assert.equal(converted.flag, true, "framework validation must convert boolean-like strings before execute");
assert.equal(converted.count, 30, "framework validation must convert numeric-like strings before execute");
assert.equal(converted.mode, "scan", "framework validation must preserve valid enum values");

assert.throws(() => validateToolArguments(strictTool, {
	name: strictTool.name,
	arguments: { flag: true, count: 30, mode: "scan", bogusField: 1 },
}), (error) => {
	assert.match(error.message, /must not have additional properties/i, "framework validation must reject unknown top-level fields when additionalProperties:false is set");
	return true;
});

assert.throws(() => validateToolArguments(strictTool, {
	name: strictTool.name,
	arguments: { flag: true, count: 30, mode: "bogus" },
}), (error) => {
	assert.match(error.message, /must match a schema in anyOf|must be equal to constant/i, "framework validation must reject invalid literal-union enum values");
	return true;
});

console.log("tool parameter framework validation ok");
