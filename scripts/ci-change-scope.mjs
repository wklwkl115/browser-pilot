import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function requiresFullValidation(files) {
	// Only known documentation paths can skip runtime checks; unknown paths run everything.
	const documentation =
		/^(?:AGENTS\.md|README(?:\.zh-CN)?\.md|docs\/.*\.md|docs\/assets\/.*\.(?:svg|png|jpe?g|gif|webp))$/;
	return !files?.length || files.some((file) => !documentation.test(file));
}

export function changedFiles(base, cwd = process.cwd()) {
	if (!/^[a-f0-9]{40,64}$/i.test(base ?? "") || /^0+$/.test(base)) return null;
	try {
		// Disabling rename detection keeps both paths visible when code is moved into docs.
		return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.split("\0")
			.filter(Boolean);
	} catch {
		return null;
	}
}

async function main() {
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	const files = changedFiles(event.pull_request?.base?.sha ?? event.before);
	const full = requiresFullValidation(files);
	appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
	console.log(full ? "Full verification and browser checks required." : "Documentation-only checks selected.");
	if (full) return;

	const prettier = await import("prettier");
	for (const file of files.filter((file) => file.endsWith(".md") && existsSync(file))) {
		const options = { ...(await prettier.resolveConfig(file)), filepath: file };
		if (!(await prettier.check(readFileSync(file, "utf8"), options))) {
			console.error(`Formatting check failed: ${file}`);
			process.exitCode = 1;
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main();
}
