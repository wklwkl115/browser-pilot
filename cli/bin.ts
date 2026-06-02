#!/usr/bin/env node
import { main } from "./index.js";

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(1);
	});
