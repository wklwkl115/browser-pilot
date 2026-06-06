import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function resolveReadPath(relOrAbs) {
	if (path.isAbsolute(relOrAbs)) return relOrAbs;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(relOrAbs);
	if (drivePath) return process.platform === "win32" ? relOrAbs : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, relOrAbs);
}
const read = (relOrAbs) => readFileSync(resolveReadPath(relOrAbs), "utf8");

const commands = read("src/tools/commands.ts");
const readme = read("README.md");
const sop = read("AI_INSTALL.md");
const skill = read("skills/pi-browser-tools/SKILL.md");

assert(commands.includes('pi.registerCommand("browser-js-ast"'), "browser commands must register /browser-js-ast");
assert(commands.includes("runJsAstShell"), "/browser-js-ast must route through internal jsAstShell");
assert(commands.includes("ctx.ui.getEditorText") && commands.includes("parseBrowserJsAstArgs"), "/browser-js-ast must support explicit editor text or explicit local path input");
assert(commands.includes("JS AST reduction artifact saved"), "/browser-js-ast must surface reduction artifact saves explicitly");
assert(commands.includes('pi.registerCommand("browser-wasm"'), "browser commands must register /browser-wasm");
assert(commands.includes("runWasmShell"), "/browser-wasm must route through internal wasmShell");
assert(commands.includes("parseBrowserWasmArgs"), "/browser-wasm must support explicit local Wasm path input and --wat mode");
assert(commands.includes("Wasm bridge artifact saved"), "/browser-wasm must surface WAT bridge artifact saves explicitly");
assert(commands.includes('pi.registerCommand("browser-ws"'), "browser commands must register /browser-ws");
assert(commands.includes("runWsShell"), "/browser-ws must route through internal wsShell");
assert(commands.includes("parseBrowserWsArgs"), "/browser-ws must support explicit action/flag parsing");
assert(commands.includes("WS transcript artifact saved"), "/browser-ws must surface transcript artifact saves explicitly");
assert(readme.includes("/browser-js-ast") && readme.includes("/browser-wasm") && readme.includes("/browser-ws"), "README must document /browser-js-ast, /browser-wasm, and /browser-ws");
assert(sop.includes("/browser-js-ast") && sop.includes("/browser-wasm") && sop.includes("/browser-ws"), "AI_INSTALL.md must document /browser-js-ast, /browser-wasm, and /browser-ws");
assert(skill.includes("/browser-js-ast") && skill.includes("/browser-wasm") && skill.includes("/browser-ws") && /not (?:a )?public browser tool/.test(skill), "skill must document internal-only /browser-js-ast, /browser-wasm, and /browser-ws paths");

console.log("browser commands contract ok");
