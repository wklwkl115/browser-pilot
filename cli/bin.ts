#!/usr/bin/env node

async function run(argv: string[]): Promise<number> {
	if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") {
		const { printHelp } = await import("./help.js");
		printHelp();
		return 0;
	}
	const { main } = await import("./index.js");
	return await main(argv);
}

run(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(1);
	});
