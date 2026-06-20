import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const required = process.argv.includes("--required");
const cargoCandidates = (() => {
	const commands = process.platform === "win32" ? ["cargo.exe", "cargo"] : ["cargo"];
	const paths = [
		process.env.CARGO,
		process.platform === "win32" ? "D:/Scoop/persist/rustup/.cargo/bin/cargo.exe" : undefined,
		process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo") : undefined,
		existsSync(path.join(root, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo")) ? path.join(root, ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo") : undefined,
	];
	const binaries = [...new Set([...paths.filter(Boolean), ...commands])];
	return binaries.flatMap((command) => process.platform === "win32"
		? [
			{ command, prefix: ["+stable-x86_64-pc-windows-gnu"] },
			{ command, prefix: [] },
		]
		: [{ command, prefix: [] }]);
})();
const cargoArgs = ["build", "--manifest-path", "native/browser-pilot-kernels/Cargo.toml", "--release"];

function resolveCargoCommand() {
	for (const candidate of cargoCandidates) {
		const probe = spawnSync(candidate.command, [...candidate.prefix, "--version"], { cwd: root, encoding: "utf8" });
		if (!probe.error && probe.status === 0) return candidate;
	}
	return null;
}

const cargo = resolveCargoCommand();
if (!cargo) {
	if (required) {
		console.error("cargo is required to build native/browser-pilot-kernels");
		process.exit(1);
	}
	if (!quiet) console.log(JSON.stringify({ ok: true, skipped: true, reason: "cargo-not-found" }, null, 2));
	process.exit(0);
}

const result = spawnSync(cargo.command, [...cargo.prefix, ...cargoArgs], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
if (!quiet) console.log(JSON.stringify({ ok: true, built: true, command: cargo.command, args: [...cargo.prefix, ...cargoArgs] }, null, 2));
