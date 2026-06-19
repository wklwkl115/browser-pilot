import { readFileSync } from "node:fs";
import path from "node:path";
import type { CliCommand } from "./registry.js";

export function applyCliOnlyParams(
	cmd: CliCommand,
	raw: Record<string, unknown>,
	cwd = process.cwd(),
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
	const params = { ...raw };
	if (cmd.name !== "browser_execute" || params.scriptFile === undefined) return { ok: true, params };
	if (typeof params.scriptFile !== "string" || !params.scriptFile) return { ok: false, error: "--script-file requires a non-empty path" };
	if (params.script !== undefined) return { ok: false, error: "--script-file cannot be combined with --script" };
	const filePath = path.resolve(cwd, params.scriptFile);
	try {
		params.script = readFileSync(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `cannot read --script-file ${filePath}: ${message}` };
	}
	delete params.scriptFile;
	return { ok: true, params };
}
