import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDesired, redactDesired } from "../../src/driver/orchestration/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

function assertRejectsInvalidDesired(input, expectedMessage, label) {
	assert.throws(
		() => normalizeDesired(input),
		(error) => {
			assert.equal(error?.code, "ORCHESTRATION_INVALID_DESIRED", `${label}: expected ORCHESTRATION_INVALID_DESIRED`);
			assert.match(String(error?.message || ""), expectedMessage, `${label}: error message mismatch`);
			return true;
		},
		label,
	);
}

const baseDesired = {
	apiVersion: "pi.browser/v1",
	orchestrationId: "pre-nav-policy-contract",
	sessions: [{
		tag: "main",
		tabs: [{ role: "main", url: "https://example.test/app", waitUntil: "none" }],
	}],
};

const disabledTopLevel = normalizeDesired({ ...baseDesired, preNavigationHooks: { enabled: false } });
assert.equal(JSON.stringify(redactDesired(disabledTopLevel)).includes("preNavigationHooks"), false, "disabled top-level preNavigationHooks must not enter normalized/redacted Desired before TODO229 runtime");
normalizeDesired({ ...baseDesired, preNavigationHooks: [] });
normalizeDesired({ ...baseDesired, sessions: [{ ...baseDesired.sessions[0], preNavigationHooks: [{ enabled: false }] }] });

assertRejectsInvalidDesired({ ...baseDesired, preNavigationHooks: [{ hookId: "early-marker", version: "1", hash: "sha256:test" }] }, /design-only until TODO229/, "enabled top-level preNavigationHooks");
assertRejectsInvalidDesired({ ...baseDesired, preNavigationHooks: { hookId: "early-marker", params: { nested: { code: "alert(1)" } } } }, /cannot include executable script\/code\/source fields/, "nested code forbidden");
assertRejectsInvalidDesired({ ...baseDesired, preNavigationHooks: { source: "window.__x=1" } }, /cannot include executable script\/code\/source fields/, "source forbidden");
assertRejectsInvalidDesired({ ...baseDesired, sessions: [{ ...baseDesired.sessions[0], preNavigationHooks: [{ hookId: "early-marker", script: "window.__x=1" }] }] }, /cannot include executable script\/code\/source fields/, "session script forbidden");
assertRejectsInvalidDesired({ ...baseDesired, sessions: [{ ...baseDesired.sessions[0], preNavigationHooks: [{ hookId: "early-marker", version: "1", hash: "sha256:test" }] }] }, /design-only until TODO229/, "enabled session preNavigationHooks");

const policy = read("docs/pre-navigation-hook-policy.md");
for (const required of [
	"TODO228",
	"TODO229",
	"frame.addNewDocumentScript",
	"no-script-persistence",
	"hookId",
	"enabled",
	"params",
	"scope",
	"version",
	"hash",
	"script",
	"code",
	"source",
	"assetPath",
	"ORCHESTRATION_INVALID_DESIRED",
	"hook-pre-nav",
]) assert(policy.includes(required), `pre-navigation policy doc missing required term: ${required}`);
assert(policy.includes("不得从外部 Desired JSON 反序列化后执行"), "policy must forbid executing scripts deserialized from external Desired JSON");
assert(policy.includes("当前可直接调用的底层原语仍是 `browser_frame` / `frame.addNewDocumentScript`"), "policy must keep raw frame primitive distinct from orchestration policy");

const coordinatorDoc = read("docs/browser-orchestration-coordinator.md");
assert(coordinatorDoc.includes("docs/pre-navigation-hook-policy.md"), "coordinator doc must link the TODO228 policy doc");
assert(coordinatorDoc.includes("TODO 229") && coordinatorDoc.includes("runtime pending"), "coordinator doc must mark pre-navigation runtime as TODO229 pending");
assert(coordinatorDoc.includes("禁止 Desired、runtime store、status、summary 与 artifact 持久化 `script`、`code`、`source`"), "coordinator doc must state no script/code/source persistence");

const roadmap = read("docs/browser-orchestration-next-roadmap.md");
assert(roadmap.includes("状态：已完成设计落档与静态契约"), "roadmap must mark TODO228 design contract complete");
assert(roadmap.includes("下一步执行 TODO229"), "roadmap next step must move to TODO229");
const todo = read("TODO.md");
assert(todo.includes("## 228. Pre-navigation Hook Policy 设计") && todo.includes("- [x] Contract：新增 `check:pre-nav-hook-policy`"), "TODO.md must mark TODO228 contract complete");
assert(todo.includes("TODO 223-228 已完成；下一步执行 TODO 229"), "TODO.md next-step ordering must point to TODO229");

const types = read("src/driver/orchestration/types.ts");
for (const requiredType of [
	"BrowserDesiredPreNavigationHookInput",
	"NormalizedPreNavigationHookMetadata",
	"PreNavigationHookRegistryEntry",
	"PreNavigationHookRegistration",
	"installPhase: \"pre-navigation\"",
]) assert(types.includes(requiredType), `orchestration types missing ${requiredType}`);
const registryBlock = types.slice(types.indexOf("export type PreNavigationHookRegistryEntry"), types.indexOf("export type PreNavigationHookRegistration"));
assert(registryBlock.includes("assetPath"), "registry entry must use assetPath for packaged hook assets");
for (const forbiddenField of ["script", "code", "source", "sourcePath"]) {
	assert.equal(new RegExp(`\\b${forbiddenField}\\b`).test(registryBlock), false, `registry entry must not expose executable field ${forbiddenField}`);
}

const normalizeSource = read("src/driver/orchestration/normalizeDesired.ts");
assert(normalizeSource.includes("assertNoPreNavigationExecutableFields"), "normalizeDesired must recursively reject executable hook fields");
assert(normalizeSource.includes("preNavigationHooks is design-only until TODO229 runtime implementation"), "normalizeDesired must reject enabled preNavigationHooks before TODO229 runtime");
for (const forbidden of ["script", "code", "source"]) assert(normalizeSource.includes(`normalizedKey === \"${forbidden}\"`), `normalizeDesired must check forbidden key: ${forbidden}`);

const schema = json("bridge/native_command_schema.json");
assert.deepEqual(schema.commands?.["frame.addNewDocumentScript"]?.required, ["source"], "raw frame.addNewDocumentScript primitive must still require source");
assert.equal(JSON.stringify(schema.commands).includes("preNavigationHooks"), false, "native command schema must not expose orchestration preNavigationHooks");
const generatedNativeDoc = read("docs/generated/native-protocol.generated.md");
assert(generatedNativeDoc.includes("`frame.addNewDocumentScript`") && generatedNativeDoc.includes("source"), "generated native docs must preserve raw frame source requirement");

const orchestrateTool = read("src/tools/registerOrchestrateTool.ts");
assert.equal(orchestrateTool.includes("preNavigationHooks"), false, "browser_orchestrate callable schema must not expose TODO229 runtime fields during TODO228 design-only stage");
const generatedToolDoc = read("docs/generated/browser-tool-contract.generated.md");
assert.equal(generatedToolDoc.includes("preNavigationHooks"), false, "generated tool contract must not expose TODO229 runtime fields during TODO228 design-only stage");

const pkg = json("package.json");
assert(String(pkg.scripts?.["check:pre-nav-hook-policy"] || "").includes("tests/contracts/check-pre-nav-hook-policy.mjs"), "package must expose check:pre-nav-hook-policy");
assert(String(pkg.scripts?.check || "").includes("check:pre-nav-hook-policy"), "npm run check must include pre-navigation hook policy contract");

console.log("pre-navigation hook policy contract ok");
