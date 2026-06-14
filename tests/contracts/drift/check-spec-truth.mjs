import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_CLAIMS } from "./spec-claims.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const exists = (rel) => existsSync(path.join(root, rel));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

function filesForGlob(glob) {
	if (Array.isArray(glob)) return glob;
	if (typeof glob !== "string") return [];
	if (!glob.includes("*")) return [glob];
	const [prefix, suffix = ""] = glob.split("*");
	const baseDir = prefix.replace(/[/\\]?$/, "");
	return walkRel(baseDir, () => true)
		.map((file) => `${baseDir}/${file}`.replace(/\\/g, "/"))
		.filter((rel) => rel.startsWith(prefix.replace(/[*].*$/, "")) && rel.endsWith(suffix));
}

function walkRel(relDir, predicate, prefix = "") {
	const abs = path.join(root, relDir, prefix);
	const out = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		const child = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walkRel(relDir, predicate, child));
		else if (predicate(entry.name, child)) out.push(child);
	}
	return out;
}

function sectionForAnchor(docText, anchor) {
	const start = docText.indexOf(anchor);
	assert(start !== -1, `claim anchor missing: ${anchor}`);
	const heading = anchor.match(/^(#+)\s/)?.[1];
	if (!heading) return docText.slice(start, Math.min(docText.length, start + 1200));
	const next = docText.slice(start + anchor.length).search(new RegExp(`\\n#{1,${heading.length}}\\s`));
	return next === -1 ? docText.slice(start) : docText.slice(start, start + anchor.length + next);
}

function hasReservedMarker(section) {
	return /\bReserved\b|保留|未实现|unimplemented/i.test(section);
}

assert.equal(hasReservedMarker("### x\nReserved / 未实现"), true, "reserved marker positive self-test");
assert.equal(hasReservedMarker("### x\nimplemented only"), false, "reserved marker negative self-test");

function assertSourceContains(claim) {
	const files = filesForGlob(claim.sourceGlob);
	assert(files.length > 0, `${claim.anchor} must declare at least one source file`);
	const hit = files.some((file) => read(file).includes(claim.symbol));
	assert(hit, `${claim.anchor} claims implemented symbol not found in ${files.join(", ")}: ${claim.symbol}`);
}

function countTsFiles(relDir) {
	return walkRel(relDir, (name) => name.endsWith(".ts"));
}

function assertManifestCounts() {
	const manifest = read("docs/abml-kernel-manifest.md");
	const pure = countTsFiles("src/abml-core").filter((file) => file !== "index.ts");
	const runtime = countTsFiles("src/abml").filter((file) => !read(`src/abml/${file}`).includes("abml-core/"));
	assert(manifest.includes(`**${pure.length} modules + an \`index.ts\` barrel.**`), "abml manifest pure-core count must match src/abml-core");
	assert(manifest.includes(`**${runtime.length} files.**`), "abml manifest runtime count must match src/abml runtime files");
	assert(manifest.includes(`## Pure core (${pure.length} `), "abml manifest pure-core section count must match source");
	assert(manifest.includes(`## Runtime (${runtime.length} `), "abml manifest runtime section count must match source");
}

const missingInternalDocs = [];
let checkedClaims = 0;

for (const docEntry of SPEC_CLAIMS) {
	if (!exists(docEntry.doc)) {
		missingInternalDocs.push(docEntry.doc);
		continue;
	}
	const docText = read(docEntry.doc);
	assert(docText.includes("> Doc-class: contract"), `${docEntry.doc} must declare Doc-class: contract`);
	for (const claim of docEntry.claims) {
		const section = sectionForAnchor(docText, claim.anchor);
		if (claim.status === "implemented") assertSourceContains(claim);
		else if (claim.status === "reserved") assert(hasReservedMarker(section), `${docEntry.doc} reserved claim lacks explicit reserved/unimplemented marker: ${claim.anchor}`);
		else assert.fail(`${docEntry.doc} has unsupported claim status: ${claim.status}`);
		checkedClaims += 1;
	}
}

if (exists("docs/abml-kernel-manifest.md")) assertManifestCounts();

const suffix = missingInternalDocs.length > 0 ? `, skipped ${missingInternalDocs.length} internal doc(s): ${missingInternalDocs.join(", ")}` : "";
console.log(`spec truth contract ok — ${checkedClaims} checked claim(s)${suffix}`);
