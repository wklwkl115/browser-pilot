import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const stdlib = read("src/tools/executeStdlib.ts");
const executeTool = read("src/tools/registerExecuteTool.ts");

assert(stdlib.includes('process.env.PI_BROWSER_STDLIB !== "0"'), "execute stdlib must keep PI_BROWSER_STDLIB=0 kill switch");
assert(stdlib.includes("const PI_STDLIB_NAMES = [\"resolve\", \"box\", \"setValue\", \"settled\"]"), "execute stdlib namespace must stay pinned");
assert(stdlib.includes("resolveRefUriDetailed"), "execute stdlib must embed registered pi-ref descriptors instead of selector transcription");
assert(!/\bclick\s*[:(]/.test(stdlib), "execute stdlib must not introduce semantic pi.click-style verbs");
assert(!/\btype\s*[:(]/.test(stdlib), "execute stdlib must not introduce semantic pi.type-style verbs");

assert(executeTool.includes("prepareExecuteStdlib(params.script)"), "browser_execute must prepare stdlib from the original script");
assert(executeTool.includes("preparedScript.script"), "browser_execute must execute the stdlib-prepared script");
assert(executeTool.includes('piRuntime: "1"'), "browser_execute must surface piRuntime only when stdlib is injected");
assert(executeTool.includes("refsEmbedded") && executeTool.includes("resolveMisses"), "browser_execute must surface stdlib ref embedding and miss counts");
assert(executeTool.includes("stdlib: preparedScript.stdlib ? { used: true"), "execution journal must record stdlib use");

console.log("execute stdlib contract ok");
