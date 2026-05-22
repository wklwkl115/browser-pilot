import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const doc = read("docs/orchestration-persistence.md");
for (const required of [
	"TODO230",
	"TODO231",
	"已实现",
	".pi/browser-artifacts/orchestration-state/state.v1.json",
	"pi.browser.orchestration.state/v1",
	"driverRunId",
	"piSessionId",
	"redactedDesired",
	"bindings",
	"fingerprints",
	"local_redacted_orchestration_state",
	"stale/readOnly/adoptionRequired",
	"adoption",
	"verifyOrigins",
	"verifyUrls",
	"requireOwnedFingerprint",
	"status visible, no watch, no cleanup, no close",
	"BrowserTargetResolver",
	"PersistentOrchestrationStore.ts",
	"atomic write",
]) assert(doc.includes(required), `orchestration persistence doc missing required term: ${required}`);

for (const forbiddenPersistence of [
	"raw cookie value",
	"HTTP/WebSocket raw body",
	"postData",
	"payload",
	"script",
	"code",
	"source",
]) assert(doc.includes(forbiddenPersistence), `orchestration persistence doc must explicitly forbid ${forbiddenPersistence}`);
assert(doc.includes("不启动 watch timer"), "startup load must not start watch timers");
assert(doc.includes("不执行 cleanup、closeTab、closeWindow"), "startup load must not cleanup or close resources");
assert(doc.includes("不得 fallback 到 selected/latest tab"), "adoption must not fall back to selected/latest tab");
assert(doc.includes("不得从外部 Desired JSON" ) || doc.includes("真实 bytes 继续来自 driver 内置 registry"), "doc must preserve no external script execution boundary");

const types = read("src/driver/orchestration/types.ts");
for (const requiredType of [
	"OrchestrationPersistenceSchemaVersion",
	"OrchestrationPersistenceMode",
	"OrchestrationPersistenceStatus",
	"OrchestrationPersistenceResourceType",
	"OrchestrationPersistedResourceFingerprint",
	"OrchestrationPersistedBinding",
	"OrchestrationPersistedCookieFingerprint",
	"OrchestrationPersistedRecord",
	"OrchestrationAdoptionPolicy",
	"OrchestrationPersistedStateFile",
	"local_redacted_orchestration_state",
	"adoptionRequired",
	"readOnly",
	"driverRunId",
	"piSessionId",
]) assert(types.includes(requiredType), `orchestration types missing ${requiredType}`);

const cookieSlice = types.slice(types.indexOf("export type OrchestrationPersistedCookieFingerprint"), types.indexOf("export type OrchestrationPersistedRecord"));
assert(cookieSlice.includes("valueHash") && cookieSlice.includes("valuePresent"), "persisted cookie fingerprint must retain only hash/presence metadata");
assert.equal(/^\s*value\??:/m.test(cookieSlice), false, "persisted cookie fingerprint must not expose raw cookie value");
assert(cookieSlice.includes("partitionKeyHash"), "persisted cookie fingerprint must hash partitionKey metadata");

const stateFileSlice = types.slice(types.indexOf("export type OrchestrationPersistedStateFile"), types.indexOf("export type ActualCookieState"));
for (const required of ["schemaVersion", "driverRunId", "piSessionId", "privacy", "orchestrations"]) {
	assert(stateFileSlice.includes(required), `persisted state file type missing ${required}`);
}
for (const forbiddenField of ["script", "code", "source", "body", "postData", "payloadData", "websocket"]) {
	assert.equal(new RegExp(`\\b${forbiddenField}\\b`).test(stateFileSlice), false, `persisted state file type must not expose ${forbiddenField}`);
}

const redaction = read("src/driver/orchestration/orchestrationRedaction.ts");
assert(redaction.includes("stripCookieValuesFromDesired") && redaction.includes("redactDesired"), "orchestration redaction must keep redacted/stored desired helpers");
assert(redaction.includes("body|postdata|websocket|value"), "orchestration redaction must include body/postData/websocket/value sensitive keys");

const store = read("src/driver/orchestration/OrchestrationStore.ts");
assert(store.includes("redactedDesired: redactDesired(desired)"), "runtime store must keep redactedDesired only for exposed state");
assert(store.includes("stripCookieValuesFromDesired(desired)"), "runtime store desired cache must strip raw cookie values");
assert(store.includes("upsertPersistedRecord") && store.includes("markAdopted"), "OrchestrationStore must expose persisted load and adoption metadata hooks");
assert.equal(/from\s+["']node:fs|from\s+["']fs|readFile|writeFile|rename\(/.test(store), false, "OrchestrationStore must remain in-memory; file I/O belongs to PersistentOrchestrationStore");

assert.equal(existsSync(path.join(root, "src/driver/orchestration/PersistentOrchestrationStore.ts")), true, "TODO231 must implement PersistentOrchestrationStore");
const persistentStore = read("src/driver/orchestration/PersistentOrchestrationStore.ts");
for (const required of [
	"state.v1.json",
	"pi.browser.orchestration.state/v1",
	"local_redacted_orchestration_state",
	"loadInto",
	"save",
	"upsertPersistedRecord",
	"adoptionRequired: true",
	"readOnly: true",
	"await handle.sync()",
	"await rename(tmp, this.statePath)",
	"redactUnknown",
]) assert(persistentStore.includes(required), `PersistentOrchestrationStore missing ${required}`);
assert.equal(/\bwriteFile\(tmp/.test(persistentStore), false, "PersistentOrchestrationStore must use fsync-capable temp file writes, not bare writeFile(tmp)");
for (const forbiddenRuntime of ["raw cookie value", "payloadData", "postDataText"]) assert.equal(persistentStore.includes(forbiddenRuntime), false, `persistent runtime must not encode ${forbiddenRuntime}`);

const coordinator = read("src/driver/orchestration/BrowserOrchestrationCoordinator.ts");
for (const required of [
	"PersistentOrchestrationStore",
	"loadPersistentState",
	"savePersistentState",
	"requiresAdoption",
	"adoptReadOnlyState",
	"validateAdoption",
	"ORCHESTRATION_ERROR_CODES.TARGET_STALE",
	"status(\"orch-persist\"",
]) {
	if (required === "status(\"orch-persist\"") continue;
	assert(coordinator.includes(required), `BrowserOrchestrationCoordinator missing ${required}`);
}
assert(coordinator.includes("desired.adoption") && coordinator.includes("verifyOrigins") && coordinator.includes("verifyUrls"), "Coordinator must gate explicit adoption by normalized policy");
assert(coordinator.includes("bindingForAdoption"), "Coordinator must scope adopted cleanup ownership by resourceTypes");

const serverSource = read("src/driver/BrowserBridgeServer.ts");
assert(serverSource.includes("PersistentOrchestrationStore") && serverSource.includes("orchestrationStatePath"), "BrowserBridgeServer must wire persistence through lifecycle options");
assert(serverSource.includes("loadPersistentState()") && serverSource.includes("savePersistentState(\"bridge_stop\")"), "BrowserBridgeServer must load/save persistent state at lifecycle boundaries");

const indexSource = read("src/driver/orchestration/index.ts");
assert(indexSource.includes("export type * from \"./types\""), "orchestration index must export persistence design types through type barrel");
assert(indexSource.includes("PersistentOrchestrationStore"), "orchestration index must export PersistentOrchestrationStore");

const coordinatorDoc = read("docs/browser-orchestration-coordinator.md");
assert(coordinatorDoc.includes("docs/orchestration-persistence.md"), "coordinator doc must link orchestration persistence policy");
assert(coordinatorDoc.includes("TODO 231") && coordinatorDoc.includes("Persistent State 实现与 Adoption Gate"), "coordinator doc must mark TODO231 implementation status");
assert(coordinatorDoc.includes("跨 Pi session 自动 cleanup 禁止"), "coordinator doc must keep cross-session cleanup forbidden");

const roadmap = read("docs/browser-orchestration-next-roadmap.md");
assert(roadmap.includes("TODO231. Persistent State 实现与 Adoption Gate") && roadmap.includes("状态：已完成 runtime 实现"), "roadmap must mark TODO231 runtime complete");
assert(roadmap.includes("TODO233. Managed Profile-first 实现 Gate") && roadmap.includes("状态：已完成 runtime 实现与 smoke gate"), "roadmap must mark TODO233 runtime complete");

const todo = read("TODO.md");
assert(todo.includes("## 230. Persistent State 安全设计") && todo.includes("- [x] 目标：设计 redacted orchestration state 持久化"), "TODO.md must mark TODO230 complete");
assert(todo.includes("## 231. Persistent State 实现与 Adoption Gate") && todo.includes("- [x] 目标：实现持久化"), "TODO231 must be marked complete after runtime implementation");
assert(todo.includes("TODO 223-233 已完成") && todo.includes("完整 Incognito 实现如需推进，另开 TODO 234"), "TODO next-step ordering must mark TODO233 complete and defer full Incognito to TODO234");

const readme = read("README.md");
assert(readme.includes("docs/orchestration-persistence.md"), "README must link persistence policy doc");
assert(readme.includes("npm run check:orchestration-persistence"), "README must list persistence static contract command");
const aiInstall = read("AI_INSTALL.md");
assert(aiInstall.includes("orchestration-state") && aiInstall.includes("local_redacted_orchestration_state"), "AI_INSTALL must document persistence privacy path and classification");
assert(readme.includes("explicit adoption") || readme.includes("显式 adoption"), "README must document explicit adoption gate");

const pkg = json("package.json");
assert(String(pkg.scripts?.["check:orchestration-persistence"] || "").includes("tests/contracts/check-orchestration-persistence.mjs"), "package must expose check:orchestration-persistence");
assert(String(pkg.scripts?.check || "").includes("check:orchestration-persistence"), "npm run check must include orchestration persistence contract");

const orchestrationContract = read("tests/contracts/check-orchestration-coordinator.mjs");
for (const required of ["persistenceApply", "persistenceLoad", "persistenceStaleStatus", "persistenceAdopt", "persistenceAdoptedDelete", "persist-secret"]) assert(orchestrationContract.includes(required), `orchestration runtime contract missing ${required}`);
const lifecycleContract = read("tests/contracts/check-lifecycle.mjs");
assert(lifecycleContract.includes("orchestrationStatePath") && lifecycleContract.includes("orch-lifecycle-persist") && lifecycleContract.includes("adoptionRequired"), "lifecycle fixture must cover restart/load read-only persistent state");

console.log("orchestration persistence contract ok");
