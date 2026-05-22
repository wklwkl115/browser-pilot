import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDesired, preNavigationHookRegistryHash, redactDesired } from "../../src/driver/orchestration/index.ts";

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

const markerHash = preNavigationHookRegistryHash();
const disabledTopLevel = normalizeDesired({ ...baseDesired, preNavigationHooks: { enabled: false } });
assert.equal(disabledTopLevel.sessions[0].preNavigationHooks.length, 0, "disabled top-level preNavigationHooks must normalize to an empty hook list");
normalizeDesired({ ...baseDesired, preNavigationHooks: [] });
normalizeDesired({ ...baseDesired, sessions: [{ ...baseDesired.sessions[0], preNavigationHooks: [{ enabled: false }] }] });
const normalizedHook = normalizeDesired({ ...baseDesired, preNavigationHooks: [{ hookId: "pi.preNavigationMarker", version: "1", hash: markerHash }] });
assert.equal(normalizedHook.sessions[0].preNavigationHooks[0].hookId, "pi.preNavigationMarker", "TODO229 runtime must accept registry-backed preNavigationHooks");
assert.equal(JSON.stringify(redactDesired(normalizedHook)).includes("__PI_BROWSER_PRE_NAVIGATION_HOOKS__"), false, "redacted Desired must not expose raw pre-navigation hook script bytes");
assertRejectsInvalidDesired({ ...baseDesired, preNavigationHooks: [{ hookId: "early-marker", version: "1", hash: "sha256:test" }] }, /hash must be sha256|registry entry is not found/, "unknown enabled preNavigationHooks must fail registry validation");
assertRejectsInvalidDesired({ ...baseDesired, preNavigationHooks: { hookId: "early-marker", params: { nested: { code: "alert(1)" } } } }, /cannot include executable script\/code\/source fields/, "nested code forbidden");
assertRejectsInvalidDesired({ ...baseDesired, preNavigationHooks: { source: "window.__x=1" } }, /cannot include executable script\/code\/source fields/, "source forbidden");
assertRejectsInvalidDesired({ ...baseDesired, sessions: [{ ...baseDesired.sessions[0], preNavigationHooks: [{ hookId: "early-marker", script: "window.__x=1" }] }] }, /cannot include executable script\/code\/source fields/, "session script forbidden");
assertRejectsInvalidDesired({ ...baseDesired, sessions: [{ ...baseDesired.sessions[0], preNavigationHooks: [{ hookId: "pi.preNavigationMarker", version: "1", hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }] }] }, /hash does not match registry entry/, "session preNavigationHooks must validate registry hash");

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
assert(coordinatorDoc.includes("TODO 229") && coordinatorDoc.includes("document-start hook runtime"), "coordinator doc must mark pre-navigation runtime as implemented by TODO229");
assert(coordinatorDoc.includes("禁止 Desired、runtime store、status、summary 与 artifact 持久化 `script`、`code`、`source`"), "coordinator doc must state no script/code/source persistence");

const roadmap = read("docs/browser-orchestration-next-roadmap.md");
assert(roadmap.includes("状态：已完成 runtime 实现与 smoke gate"), "roadmap must mark TODO229 runtime complete");
assert(roadmap.includes("TODO233. Managed Profile-first 实现 Gate") && roadmap.includes("状态：已完成 runtime 实现与 smoke gate"), "roadmap must mark TODO233 runtime complete");
const todo = read("TODO.md");
assert(todo.includes("## 229. Pre-navigation Hook 实现与 Smoke") && todo.includes("- [x] Contract：`check:pre-nav-hook-policy`"), "TODO.md must mark TODO229 contract complete");
assert(todo.includes("TODO 223-238 已完成") && todo.includes("## 234. `browser_orchestrate` 术语与边界冻结") && todo.includes("## 235. `sessionAssertions/readinessChecks` 设计冻结") && todo.includes("## 236. `sessionAssertions/readinessChecks` runtime 实现 Gate") && todo.includes("## 237. 断言层真实回归与证据面") && todo.includes("## 238. `smoke:browser:isolated` 自举与 preflight 改进") && todo.includes("PI_BROWSER_SMOKE_AUTO_BUILD=0") && todo.includes("完整 Incognito 实现继续后移，另开号段"), "TODO.md must record TODO238 completion and keep Incognito deferred behind the runtime session-assertions workstream");

const types = read("src/driver/orchestration/types.ts");
for (const requiredType of [
	"BrowserDesiredPreNavigationHookInput",
	"NormalizedPreNavigationHookMetadata",
	"PreNavigationHookRegistryEntry",
	"PreNavigationHookRegistration",
	"ActualPreNavigationHookState",
	"installPhase: \"pre-navigation\"",
]) assert(types.includes(requiredType), `orchestration types missing ${requiredType}`);
const registryBlock = types.slice(types.indexOf("export type PreNavigationHookRegistryEntry"), types.indexOf("export type PreNavigationHookRegistration"));
assert(registryBlock.includes("assetPath"), "registry entry must use assetPath for packaged hook assets");
for (const forbiddenField of ["script", "code", "source", "sourcePath"]) {
	assert.equal(new RegExp(`\\b${forbiddenField}\\b`).test(registryBlock), false, `registry entry must not expose executable field ${forbiddenField}`);
}

const normalizeSource = read("src/driver/orchestration/normalizeDesired.ts");
assert(normalizeSource.includes("assertNoPreNavigationExecutableFields"), "normalizeDesired must recursively reject executable hook fields");
assert(normalizeSource.includes("resolvePreNavigationHook(normalized)"), "normalizeDesired must validate preNavigationHooks against the safe registry");
for (const forbidden of ["script", "code", "source"]) assert(normalizeSource.includes(`normalizedKey === \"${forbidden}\"`), `normalizeDesired must check forbidden key: ${forbidden}`);

const schema = json("bridge/native_command_schema.json");
assert.deepEqual(schema.commands?.["frame.addNewDocumentScript"]?.required, ["source"], "raw frame.addNewDocumentScript primitive must still require source");
assert.equal(JSON.stringify(schema.commands).includes("preNavigationHooks"), false, "native command schema must not expose orchestration preNavigationHooks");
const generatedNativeDoc = read("docs/generated/native-protocol.generated.md");
assert(generatedNativeDoc.includes("`frame.addNewDocumentScript`") && generatedNativeDoc.includes("source"), "generated native docs must preserve raw frame source requirement");

const orchestrateTool = read("src/tools/registerOrchestrateTool.ts");
assert(orchestrateTool.includes("preNavigationHooks"), "browser_orchestrate schema/docs must expose TODO229 preNavigationHooks runtime metadata");
const generatedToolDoc = read("docs/generated/browser-tool-contract.generated.md");
assert(generatedToolDoc.includes("preNavigationHooks"), "generated tool contract must expose TODO229 preNavigationHooks runtime metadata");
const registrySource = read("src/driver/orchestration/preNavigationHooks.ts");
assert(registrySource.includes("PRE_NAVIGATION_MARKER_BYTES") && registrySource.includes("sha256"), "pre-navigation hook registry must use fixed packaged bytes and sha256 hash validation");
assert(!registrySource.includes("eval(") && !registrySource.includes("new Function"), "pre-navigation hook registry must not evaluate external Desired script text");
const executorSource = read("src/driver/orchestration/ReconcileExecutor.ts");
assert(executorSource.includes("frame.addNewDocumentScript") && executorSource.includes("frame.removeNewDocumentScript"), "ReconcileExecutor must install and cleanup pre-navigation hooks through frame primitives");
assert(executorSource.includes("about:blank"), "ReconcileExecutor must create new tabs/windows as about:blank when pre-navigation hooks are requested");

const pkg = json("package.json");
assert(String(pkg.scripts?.["check:pre-nav-hook-policy"] || "").includes("tests/contracts/check-pre-nav-hook-policy.mjs"), "package must expose check:pre-nav-hook-policy");
assert(String(pkg.scripts?.check || "").includes("check:pre-nav-hook-policy"), "npm run check must include pre-navigation hook policy contract");

console.log("pre-navigation hook policy contract ok");
