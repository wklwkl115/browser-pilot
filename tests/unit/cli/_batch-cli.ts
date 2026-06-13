import { readFileSync } from "node:fs";

const arg = process.argv[2];
const invocations: string[][] = arg.endsWith(".json")
	? JSON.parse(readFileSync(arg, "utf8"))
	: JSON.parse(arg);

const { main } = await import("../../../cli/localCommands.js");
const { printHelp, helpText } = await import("../../../cli/help.js");

function capture(fn: () => unknown): Promise<{ stdout: string; code: number }> {
	let buf = "";
	const orig = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => { buf += String(chunk); return true; }) as typeof process.stdout.write;
	const restore = () => { process.stdout.write = orig; };
	try {
		const result = fn();
		if (result && typeof (result as Promise<number>).then === "function") {
			return (result as Promise<number>).then(code => { restore(); return { stdout: buf, code }; }, err => { restore(); return { stdout: buf, code: 1 }; });
		}
		restore();
		return Promise.resolve({ stdout: buf, code: typeof result === "number" ? result : 0 });
	} catch {
		restore();
		return Promise.resolve({ stdout: buf, code: 1 });
	}
}

const results: Array<{ stdout: string; code: number }> = [];
for (const argv of invocations) {
	const r = await capture(() => main(argv));
	results.push(r);
}

process.stdout.write(JSON.stringify(results) + "\n");
