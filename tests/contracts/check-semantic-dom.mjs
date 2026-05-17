import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSemanticDomActionScript, buildSemanticDomSnapshotScript } from "../../src/dom/buildSemanticDomScript.ts";
import { summarizeSemanticDomActionData, summarizeSemanticDomSnapshotData } from "../../src/tools/summaries/index.ts";

const root = new URL("../..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const snapshot = buildSemanticDomSnapshotScript({ maxNodes: 25, includeIframes: true, textLimit: 120 });
new Function(snapshot);
assert(snapshot.includes("getBoundingClientRect"), "semantic DOM snapshot must return bounding boxes");
assert(snapshot.includes("clickable") && snapshot.includes("editable"), "semantic DOM snapshot must classify clickable/editable nodes");
assert(snapshot.includes("ariaLabel") && snapshot.includes("role"), "semantic DOM snapshot must include aria-label and role semantics");
assert(snapshot.includes("selector") && snapshot.includes("path") && snapshot.includes("framePath"), "semantic DOM snapshot must include selector/path/framePath for DOM-based actions");
assert(snapshot.includes("framePath: framePath.slice()"), "semantic DOM snapshot must clone framePath per node to avoid circular serialization artifacts");
assert(snapshot.includes("intersectRects") && snapshot.includes("frameClip") && snapshot.includes("collect(child, framePath.concat(selector), rect.x, rect.y, depth + 1, frameClip)"), "semantic DOM snapshot must clip iframe child nodes to the ancestor frame visible rectangle");
assert(snapshot.includes("read-frog-translated") && snapshot.includes("mate-translate"), "semantic DOM snapshot must reuse translation noise rules");
assert(!snapshot.includes("elementFromPoint"), "semantic DOM snapshot must not depend on screen coordinate picking");

const click = buildSemanticDomActionScript({ action: "click", nodeId: "dom_1_n1", selector: "#go", path: "button#go", framePath: [] });
new Function(click);
assert(click.includes("querySelector") && click.includes("scrollIntoView") && click.includes("el.click()"), "semantic DOM click must resolve DOM selectors and click the element");
assert(click.includes("!clickable(el)") && click.includes("DOM_NODE_NOT_CLICKABLE"), "semantic DOM click must reject non-clickable semantic nodes before calling click");
assert(click.includes("clickable: clickable(el)") && click.includes("framePath: (options.framePath || []).slice()") && click.includes("rootOffset(options.framePath)"), "semantic DOM action summaries must preserve clickability, framePath, and root-relative bbox");
assert(!click.includes("MouseEvent") && !click.includes("clientX"), "semantic DOM click must not synthesize screen-coordinate mouse events");

const type = buildSemanticDomActionScript({ action: "type", nodeId: "dom_1_n2", selector: "input[name=q]", path: "input", framePath: [], text: "hello", clear: true });
new Function(type);
assert(type.includes("DOM_NODE_NOT_EDITABLE") && type.includes("setNativeValue(el, next)") && type.includes("InputEventCtor") && type.includes("Object.getOwnPropertyDescriptor(proto, 'value')"), "semantic DOM type must validate editability and use native value setter plus InputEvent dispatch");

const snapshotSummary = summarizeSemanticDomSnapshotData({ snapshotId: "s1", url: "https://example.test", nodes: [
	{ nodeId: "s1_n1", selector: "#go", tag: "button", role: "button", text: "Go", clickable: true, editable: false, bbox: { x: 1 } },
	{ nodeId: "s1_n2", selector: "input[name=q]", tag: "input", role: "textbox", text: "", clickable: false, editable: true, bbox: { x: 2 } },
] });
assert.equal(snapshotSummary.nodeCount, 2, "semantic DOM summary must expose node count");
assert.equal(snapshotSummary.clickable, 1, "semantic DOM summary must count clickable nodes");
assert.equal(snapshotSummary.editable, 1, "semantic DOM summary must count editable nodes");
assert.equal(snapshotSummary.nodes[0].nodeId, "s1_n1", "semantic DOM summary must expose nodeIds");

const actionSummary = summarizeSemanticDomActionData({ action: "click", clicked: true, target: { nodeId: "s1_n1", selector: "#go", tag: "button", text: "Go", clickable: true } });
assert.equal(actionSummary.clicked, true, "semantic DOM action summary must expose action status");
assert.equal(actionSummary.target.nodeId, "s1_n1", "semantic DOM action summary must expose target nodeId");
assert.equal(actionSummary.target.clickable, true, "semantic DOM action summary must expose target clickability");

const register = read("src/tools/registerSemanticDomTools.ts");
assert(register.includes("name: \"browser_dom_snapshot\"") && register.includes("name: \"browser_dom_click\"") && register.includes("name: \"browser_dom_type\""), "semantic DOM tools must be registered");
assert(register.includes("DOM_NODE_NOT_FOUND") && register.includes("DOM_NODE_TAB_MISMATCH") && register.includes("nodeIds are short-lived"), "semantic DOM tools must expose stale nodeId/tab mismatch errors and lifecycle guidance");
assert(register.includes("unwrapSemanticDomRuntimeError") && register.includes("code.startsWith(\"DOM_NODE_\")"), "semantic DOM tools must unwrap DOM_NODE_* runtime errors for actionable stale-node failures");
assert(read("src/tools/budgets.ts").includes("browser_dom_snapshot"), "semantic DOM tools must have result budgets");

console.log("semantic DOM contract ok");
