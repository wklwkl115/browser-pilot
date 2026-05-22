import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const designDoc = read("docs/browser-orchestration-assertions.md");
for (const required of [
	"设计与 runtime 已完成",
	"canonical desired field",
	"sessionAssertions",
	"readinessChecks",
	"workflow DSL",
	"browser_execute",
	"browser_scan",
	"browser_wait",
	"script",
	"code",
	"source",
	"url",
	"origin",
	"loadState",
	"cookie",
	"storage",
	"selector",
	"text",
	"attribute",
	"hook",
	"networkRecorder",
	"profile",
	"ORCHESTRATION_ASSERTION_INVALID",
	"ORCHESTRATION_ASSERTION_FAILED",
	"ORCHESTRATION_ASSERTION_PROBE_FAILED",
	"npm run check:orchestration-assertions-design",
]) assert(designDoc.includes(required), `assertions design doc missing required term: ${required}`);
assert(designDoc.includes("不是第二个 schema alias"), "design doc must reject a second schema alias for readinessChecks");
assert(designDoc.includes("不执行断言 probe") && designDoc.includes("再执行 assertions verify"), "design doc must freeze plan/apply assertion semantics");
assert(designDoc.includes("只产生 diagnostics") && designDoc.includes("不能替智能体点击“重新登录”"), "design doc must keep DOM/storage assertions diagnostic-only");

const readme = read("README.md");
assert(readme.includes("docs/browser-orchestration-assertions.md"), "README must link assertions design doc");
assert(readme.includes("npm run check:orchestration-assertions-design"), "README must list the assertions design contract command");
assert(readme.includes("TODO 236 已实现 `sessionAssertions` runtime readiness checks") && readme.includes("`readinessChecks` 仍不是 schema alias"), "README must expose current assertions runtime while preserving the no-alias boundary");

const roadmap = read("docs/browser-orchestration-next-roadmap.md");
assert(roadmap.includes("### TODO235. `sessionAssertions/readinessChecks` 设计冻结") && roadmap.includes("状态：已完成。"), "roadmap must record TODO235 as complete");
assert(roadmap.includes("### TODO236. `sessionAssertions/readinessChecks` runtime 实现 Gate") && roadmap.includes("状态：已完成。"), "roadmap must record TODO236 runtime completion");
assert(roadmap.includes("### TODO237. 断言层真实回归与证据面") && roadmap.includes("smoke-orchestration-assertions-result.json"), "roadmap must record TODO237 runtime smoke completion");
assert(roadmap.includes("下一步先做 TODO238") && roadmap.includes("完整 Incognito 实现继续后移"), "roadmap must move next-step ordering to TODO238 after TODO237");

const coordinatorDoc = read("docs/browser-orchestration-coordinator.md");
assert(coordinatorDoc.includes("docs/browser-orchestration-assertions.md"), "coordinator doc must link assertions design doc");
assert(coordinatorDoc.includes("`sessionAssertions` 只允许可观测、只读的 readiness checks") && coordinatorDoc.includes("`readinessChecks` 也不得作为第二个 schema alias"), "coordinator doc must freeze assertions as read-only runtime checks with no alias drift");

const todo = read("TODO.md");
assert(todo.includes("## 235. `sessionAssertions/readinessChecks` 设计冻结") && todo.includes("- [x] 目标：已在不把 `browser_orchestrate` 变成流程 DSL 的前提下，冻结“声明式业务就绪断言”设计。"), "TODO.md must mark TODO235 complete");
assert(todo.includes("## 236. `sessionAssertions/readinessChecks` runtime 实现 Gate") && todo.includes("- [x] 目标：已实现断言层"), "TODO.md must mark TODO236 complete");
assert(todo.includes("## 237. 断言层真实回归与证据面") && todo.includes("- [x] 目标：已用真实浏览器回归证明断言层没有把 `browser_orchestrate` 变成脆弱的黑盒流程器。") && todo.includes("下一步先做 TODO238") && todo.includes("完整 Incognito 实现继续后移，另开号段"), "TODO.md must mark TODO237 complete and move next-step ordering to TODO238");

const changelog = read("CHANGELOG.md");
assert(changelog.includes("完成 TODO 235 `sessionAssertions/readinessChecks` 设计冻结") && changelog.includes("完成 TODO 236 `sessionAssertions/readinessChecks` runtime 实现 Gate") && changelog.includes("完成 TODO 237 断言层真实回归与证据面"), "CHANGELOG must record TODO235-237 assertions workstream");

const generatedToolDoc = read("docs/generated/browser-tool-contract.generated.md");
assert(generatedToolDoc.includes("sessionAssertions readiness checks") && generatedToolDoc.includes("readinessChecks remains"), "generated tool docs must expose current sessionAssertions runtime wording and no-alias boundary");
const orchestrateTool = read("src/tools/registerOrchestrateTool.ts");
assert(orchestrateTool.includes("sessionAssertions readiness checks") && orchestrateTool.includes("readinessChecks alias"), "browser_orchestrate tool metadata must expose runtime assertions wording and no-alias boundary");

const pkg = json("package.json");
assert(String(pkg.scripts?.["check:orchestration-assertions-design"] || "").includes("tests/contracts/check-orchestration-assertions-design.mjs"), "package must expose check:orchestration-assertions-design");
assert(String(pkg.scripts?.check || "").includes("check:orchestration-assertions-design"), "npm run check must include assertions design contract");

console.log("orchestration assertions design contract ok");
