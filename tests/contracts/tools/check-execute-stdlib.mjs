import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const stdlib = read("src/tools/executeStdlib.ts");
const prelude = read("src/tools/executeStdlibPrelude.ts");
const combinedStdlib = stdlib + "\n" + prelude;
const executeTool = read("src/tools/registerExecuteTool.ts");
const execBridge = read("bridge_src/service_worker/exec.ts");

assert(stdlib.includes('process.env.PI_BROWSER_STDLIB !== "0"'), "execute stdlib must keep PI_BROWSER_STDLIB=0 kill switch");
assert(combinedStdlib.includes("const PI_STDLIB_NAMES = [\"resolve\", \"box\", \"setValue\", \"settled\", \"click\"]"), "execute stdlib namespace must stay pinned with only dispatch-only pi.click added");
assert(stdlib.includes("resolveRefUriDetailed"), "execute stdlib must embed registered pi-ref descriptors instead of selector transcription");
assert(combinedStdlib.includes("PI_CLICK_BINDING_PLACEHOLDER"), "execute stdlib pi.click must route through the execute-time privileged binding placeholder");
assert(combinedStdlib.includes("function click(ref, options = {})"), "execute stdlib must expose only dispatch-only pi.click as the reopened action namespace");
assert(!/\btype\s*[:(]/.test(combinedStdlib), "execute stdlib must not introduce semantic pi.type-style verbs");
assert(!combinedStdlib.includes('cmd: "input.pointer"') && !combinedStdlib.includes("BrowserBridgeCommandService"), "execute stdlib must not dispatch native input through Node command services");

assert(executeTool.includes("prepareExecuteStdlib(params.script)"), "browser_execute must prepare stdlib from the original script");
assert(executeTool.includes("preparedScript.script"), "browser_execute must execute the stdlib-prepared script");
assert(executeTool.includes('piRuntime: "1"'), "browser_execute must surface piRuntime only when stdlib is injected");
assert(executeTool.includes("refsEmbedded") && executeTool.includes("resolveMisses"), "browser_execute must surface stdlib ref embedding and miss counts");
assert(executeTool.includes("stdlib: preparedScript.stdlib ? { used: true"), "execution journal must record stdlib use");
assert(execBridge.includes("Runtime.addBinding") && execBridge.includes("Runtime.bindingCalled") && execBridge.includes("handlePiBrowserRefInputCommand"), "bridge execute must service pi.click through an in-flight Runtime.addBinding path");
assert(!execBridge.includes("BrowserBridgeCommandService") && !execBridge.includes("sendCommand({ cmd: \"input.ref\""), "bridge execute pi.click must not enqueue a nested Node write");

console.log("execute stdlib contract ok");
