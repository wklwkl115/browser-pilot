import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpmSync } from "../support/npm-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactPath = path.join(root, ".pi", "browser-artifacts", "dependency-audit-summary.json");
const auditTimeoutMs = Number(process.env.PI_BROWSER_DEP_AUDIT_TIMEOUT_MS || 15_000);
const allowedAuditUnavailableCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

async function readJson(rel) {
	return JSON.parse(await readFile(path.join(root, rel), "utf8"));
}

function sortedObject(value = {}) {
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function listProdDeps(pkg) {
	return Object.keys(pkg.dependencies || {}).sort();
}

function execNpm(args, options = {}) {
	const result = runNpmSync(args, { cwd: root, timeout: options.timeoutMs ?? 30_000, maxBuffer: 20 * 1024 * 1024 });
	return {
		ok: result.ok,
		code: result.status ?? result.error?.code,
		signal: result.signal,
		timedOut: result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT",
		stdout: result.stdout,
		stderr: result.stderr,
		message: result.error?.message,
		command: result.command,
		argv: result.argv,
	};
}

function parseJsonOutput(result) {
	const text = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

function auditUnavailable(result, auditJson) {
	const text = `${result.message || ""}\n${result.stdout || ""}\n${result.stderr || ""}`;
	if (result.timedOut || result.signal === "SIGTERM") return true;
	if (auditJson?.error?.code && allowedAuditUnavailableCodes.has(String(auditJson.error.code))) return true;
	if (/endpoint is being retired/i.test(text) || /security\/audits\/quick\s*-\s*Bad Request/i.test(text) || /audit endpoint returned an error/i.test(text)) return true;
	return [...allowedAuditUnavailableCodes].some((code) => text.includes(code));
}

function auditVulnerabilitySummary(auditJson) {
	const metadata = auditJson?.metadata?.vulnerabilities || {};
	return {
		info: Number(metadata.info || 0),
		low: Number(metadata.low || 0),
		moderate: Number(metadata.moderate || 0),
		high: Number(metadata.high || 0),
		critical: Number(metadata.critical || 0),
		total: Number(metadata.total || 0),
	};
}

function sanitizeText(value) {
	return String(value || "").replace(/(token|authorization|cookie|password|secret)=([^\s&]+)/gi, "$1=[REDACTED]").slice(0, 4000);
}

async function main() {
	const pkg = await readJson("package.json");
	const lock = await readJson("package-lock.json");
	const lockRoot = lock.packages?.[""];
	assert(lockRoot, "package-lock root package metadata missing");
	assert.equal(lockRoot.name, pkg.name, "package-lock root name must match package.json");
	assert.equal(lockRoot.version, pkg.version, "package-lock root version must match package.json");
	assert.deepEqual(sortedObject(lockRoot.dependencies), sortedObject(pkg.dependencies), "package-lock production dependencies must match package.json");
	assert.deepEqual(sortedObject(lockRoot.devDependencies), sortedObject(pkg.devDependencies), "package-lock devDependencies must match package.json");
	assert.deepEqual(sortedObject(lockRoot.peerDependencies), sortedObject(pkg.peerDependencies), "package-lock peerDependencies must match package.json");
	assert.deepEqual(sortedObject(lockRoot.peerDependenciesMeta), sortedObject(pkg.peerDependenciesMeta), "package-lock peerDependenciesMeta must match package.json");
	assert.deepEqual(listProdDeps(pkg), ["js-yaml", "typescript", "ws"], "production dependency allowlist drift: update TODO/README/CHANGELOG when changing runtime dependencies");

	const lsResult = await execNpm(["ls", "--json", "--all"], { timeoutMs: 30_000 });
	const lsJson = parseJsonOutput(lsResult);
	assert(lsResult.ok, `npm ls must succeed: ${sanitizeText(lsResult.stderr || lsResult.stdout || lsResult.message)}`);
	assert(!lsJson?.problems?.length, `npm ls reported dependency problems: ${JSON.stringify(lsJson.problems)}`);

	const auditResult = await execNpm(["audit", "--omit=dev", "--json", "--audit-level=high"], { timeoutMs: auditTimeoutMs });
	const auditJson = parseJsonOutput(auditResult);
	const audit = { status: "passed", unavailable: false, vulnerabilities: auditVulnerabilitySummary(auditJson) };
	if (!auditResult.ok) {
		if (auditUnavailable(auditResult, auditJson)) {
			audit.status = "unavailable";
			audit.unavailable = true;
			audit.reason = sanitizeText(auditJson?.error?.summary || auditJson?.error?.detail || auditResult.stderr || auditResult.message);
		} else {
			const vulns = auditVulnerabilitySummary(auditJson);
			if (vulns.high > 0 || vulns.critical > 0) {
				audit.status = "failed";
				audit.vulnerabilities = vulns;
			} else {
				throw new Error(`npm audit failed: ${sanitizeText(auditResult.stderr || auditResult.stdout || auditResult.message)}`);
			}
		}
	}
	if (audit.status === "failed") {
		throw new Error(`npm audit found high/critical production vulnerabilities: ${JSON.stringify(audit.vulnerabilities)}`);
	}

	const summary = {
		ok: true,
		generatedAt: new Date().toISOString(),
		lockfile: { name: lockRoot.name, version: lockRoot.version, lockfileVersion: lock.lockfileVersion },
		productionDependencies: listProdDeps(pkg).map((name) => ({ name, range: pkg.dependencies[name], locked: lock.packages?.[`node_modules/${name}`]?.version })),
		devDependencies: Object.keys(pkg.devDependencies || {}).sort().map((name) => ({ name, range: pkg.devDependencies[name], locked: lock.packages?.[`node_modules/${name}`]?.version })),
		npmLs: { ok: true, dependencyCount: Object.keys(lock.packages || {}).filter(Boolean).length },
		npmAudit: audit,
	};
	await mkdir(path.dirname(artifactPath), { recursive: true });
	await writeFile(artifactPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	console.log("dependency contract ok");
	if (audit.unavailable) console.log(`npm audit unavailable; recorded warning in ${path.relative(root, artifactPath)}`);
}

await main();
