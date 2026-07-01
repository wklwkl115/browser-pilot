#!/usr/bin/env node

function missingBuildRecovery(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = (error as NodeJS.ErrnoException).code;
	const message = error.message || "";
	if (code !== "ERR_MODULE_NOT_FOUND" && !/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) return undefined;
	return [
		"browser-pilot CLI is missing built files required by the package entrypoint.",
		"Recovery for a source checkout: run `npm run build` from the package root, then retry.",
		"Recovery for a global/package install: reinstall browser-pilot so dist/src/apps/cli/bin.js and adjacent files are present.",
	].join("\n");
}

async function run(argv: string[]): Promise<number> {
	if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
		const { printHelp } = await import("./help.js");
		printHelp();
		return 0;
	}
	const { main } = await import("./main.js");
	return await main(argv);
}

run(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error) => {
		const recovery = missingBuildRecovery(error);
		process.stderr.write(`${recovery ?? (error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
		process.exit(1);
	});
